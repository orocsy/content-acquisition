'use strict';

/**
 * dispatch/actions/scrape.js — the main sequential scrape flow.
 *
 * Provider-agnostic orchestration:
 *   - launches browser via provider.setupBrowser()
 *   - applies auth and stealth via provider hooks
 *   - discovers/loads curriculum from cache or provider.discoverCurriculum()
 *   - iterates lessons in order using provider.clickNextLesson()
 *   - calls the `pdf` and `video` action helpers per lesson
 *   - maintains resumable state via core/state.js
 *   - writes course-map.json after every navigation
 *
 * Options (all passed through from CLI args):
 *   provider         — provider instance (required)
 *   url              — start URL (required)
 *   outDir           — base output directory
 *   headless         — bool
 *   executablePath   — browser binary
 *   timeoutMs        — navigation timeout
 *   minDelayMs       — min inter-lesson delay
 *   maxDelayMs       — max inter-lesson delay
 *   skipVideos       — bool
 *   skipPdf          — bool
 *   resume           — bool
 *   refreshCurriculum — bool
 */

const path = require('path');
const {
  safeMkdir,
  sleep,
  randomBetween,
  formatMs,
  writeJson,
} = require('../../core/utils');
const {
  loadCourseFiles,
  ensureCourseState,
  hydrateStateFromManifest,
  computeResumePlan,
  findNextLessonIndex,
  updateLessonState,
  markLessonDone,
  writeManifestFromState,
} = require('../../core/state');
const {
  readCourseMap,
  writeCourseMap,
  mergePageDiscovery,
  mergeCurriculum,
} = require('../../core/course-map');
const pdfAction = require('./pdf');
const videoAction = require('./video');

async function runScrape(opts) {
  const { provider } = opts;

  safeMkdir(opts.outDir);
  const startUrl = provider.normalizeUrl(opts.url);
  const ctx = provider.buildCourseContext(startUrl);
  const { coursePrefix, courseSlug } = ctx;
  const courseDir = path.join(opts.outDir, courseSlug);
  safeMkdir(courseDir);

  const loaded = loadCourseFiles(courseDir);
  const state = ensureCourseState({ courseSlug, startUrl, courseDir, loaded });
  const courseMap = readCourseMap(courseDir);
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  hydrateStateFromManifest({
    state,
    manifest: loaded.manifest,
    courseDir,
    normalizeUrl: (u) => provider.normalizeUrl(u),
  });

  const resumePlan = opts.resume !== false
    ? computeResumePlan({ state, manifest: loaded.manifest, startUrl, courseDir, normalizeUrl: (u) => provider.normalizeUrl(u) })
    : { mode: 'fresh', url: startUrl, skipCurrentDoneCheck: false };

  console.error(`[course] ${courseSlug}`);
  console.error(`[course] provider=${provider.name}`);
  console.error(`[course] output → ${courseDir}`);
  console.error(`[course] delay: ${formatMs(opts.minDelayMs)} – ${formatMs(opts.maxDelayMs)}`);
  console.error(`[resume] mode=${resumePlan.mode} url=${resumePlan.url}`);

  const { browser, page } = await provider.setupBrowser({
    headless: opts.headless !== false,
    executablePath: opts.executablePath,
  });

  await page.setRequestInterception(true);
  const capturedVideos = videoAction.createCapturedVideoSet(page, provider);
  await provider.applyStealthPatches(page);
  await provider.applyAuth(page, startUrl);
  page.setDefaultTimeout(opts.timeoutMs || 60000);

  await page.goto(resumePlan.url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: opts.timeoutMs || 60000 });

  // ── Curriculum discovery ───────────────────────────────────────────────────

  const cachedCurriculum = courseMap?.curriculum?.orderedLessons?.length
    ? courseMap.curriculum.orderedLessons
    : [];

  let curriculumOrderedLessons = [];
  if (cachedCurriculum.length > 0 && !opts.refreshCurriculum) {
    curriculumOrderedLessons = cachedCurriculum;
    console.error(`[curriculum] loaded ${curriculumOrderedLessons.length} lesson(s) from cache`);
  } else {
    try {
      const curriculum = await provider.discoverCurriculum(page, ctx);
      mergeCurriculum(courseMap, curriculum, (u) => provider.normalizeUrl(u));
      writeCourseMap(courseDir, courseMap);
      curriculumOrderedLessons = curriculum.orderedLessons || [];
      console.error(`[curriculum] discovered ${curriculumOrderedLessons.length} lesson(s) via ${curriculum.source}`);
    } catch (err) {
      console.error(`[curriculum] discovery failed: ${String(err)}`);
    }
  }

  // ── Main scrape loop ───────────────────────────────────────────────────────

  const visitedUrls = new Set();
  if (resumePlan.skipCurrentDoneCheck) {
    visitedUrls.add(provider.normalizeUrl(page.url()));
    const next = await provider.clickNextLesson(page, {
      visitedUrls,
      coursePrefix,
      courseMap,
      curriculumOrderedLessons,
      timeoutMs: opts.timeoutMs,
    });
    writeCourseMap(courseDir, courseMap);
    if (!next.ok) throw new Error(`Could not advance from last completed lesson: ${next.reason}`);
  }

  let stopReason = null;
  while (true) {
    const currentUrl = provider.normalizeUrl(page.url());
    visitedUrls.add(currentUrl);
    const existing = state.lessons[currentUrl];
    const existingPdf = existing?.dir ? path.join(courseDir, existing.dir, 'page.pdf') : null;

    const { hasValidPdf } = require('../../core/utils');
    if (existing && existing.status === 'done' && existingPdf && hasValidPdf(existingPdf)) {
      console.error(`[skip] ${currentUrl} already complete`);
    } else {
      const index = existing?.index || findNextLessonIndex(state, { coursePrefix });
      const lessonSlug = provider.lessonSlugFromUrl(currentUrl, `page-${index}`);
      const dir = existing?.dir || `${String(index).padStart(2, '0')}-${lessonSlug}`;
      const lessonDir = path.join(courseDir, dir);
      safeMkdir(lessonDir);
      updateLessonState(state, currentUrl, { index, dir, status: 'partial' });
      state.lastRunAt = new Date().toISOString();
      writeJson(path.join(courseDir, '.resume-state.json'), state);

      console.error(`\n[lesson ${index}] ${currentUrl}`);

      // Page-structure discovery (feeds course-map)
      if (provider.discoverPageStructure) {
        try {
          const discovery = await provider.discoverPageStructure(page, ctx);
          mergePageDiscovery(courseMap, discovery, (u) => provider.normalizeUrl(u));
          writeCourseMap(courseDir, courseMap);
        } catch {}
      }

      // Wait for page stability
      await waitStable(page, opts.timeoutMs);
      await humanScroll(page);
      await sleep(1500 + Math.random() * 1000);
      await waitStable(page, opts.timeoutMs);

      // Extract metadata
      const rawHtml = await page.content();
      const rawTitle = await page.title();
      const title = provider.cleanTitle ? provider.cleanTitle(rawTitle) : rawTitle.trim();

      // PDF
      let pdfOk = false;
      if (!opts.skipPdf) {
        pdfOk = await pdfAction.capturePdf(page, path.join(lessonDir, 'page.pdf'));
      }

      // Video
      const videoSourceUrls = [...new Set([
        ...capturedVideos,
        ...videoAction.extractInlineVideoUrls(rawHtml),
      ])];
      capturedVideos.clear();

      const videoFiles = [];
      let videoDownloaded = 0;
      if (!opts.skipVideos && videoSourceUrls.length > 0) {
        console.error(`  [video] ${videoSourceUrls.length} source(s) found`);
        const mediaDir = path.join(lessonDir, 'media');
        safeMkdir(mediaDir);
        for (const videoUrl of videoSourceUrls) {
          const result = videoAction.downloadVideo(videoUrl, mediaDir);
          if (result.ok) {
            videoDownloaded += 1;
            videoFiles.push(...result.files);
          }
        }
      }

      markLessonDone({
        state, courseDir, lessonKey: currentUrl, index, title, dir,
        hasVideo: videoSourceUrls.length > 0,
        videoSources: videoSourceUrls.length,
        videoDownloaded,
        videoFiles: [...new Set(videoFiles)],
      });
      console.error(`  ✓ "${title}" — ${videoDownloaded} video(s)`);
      writeJson(path.join(courseDir, '.resume-state.json'), state);
      writeManifestFromState({ manifestPath: path.join(courseDir, 'manifest.json'), state, stopReason: null });
      videoAction.writeVideoLessonsIndex(courseDir, Object.values(state.lessons));
    }

    const delay = randomBetween(opts.minDelayMs, opts.maxDelayMs);
    console.error(`  → waiting ${formatMs(delay)} before next lesson…`);
    await sleep(delay);

    const next = await provider.clickNextLesson(page, {
      visitedUrls,
      coursePrefix,
      courseMap,
      curriculumOrderedLessons,
      timeoutMs: opts.timeoutMs,
    });
    writeCourseMap(courseDir, courseMap);

    if (!next.ok) {
      stopReason = next.reason;
      console.error(`\n[done] ${stopReason}`);
      break;
    }
    state.nextUrl = next.url;
    state.lastRunAt = new Date().toISOString();
    writeJson(path.join(courseDir, '.resume-state.json'), state);
  }

  writeJson(path.join(courseDir, '.resume-state.json'), state);
  writeManifestFromState({ manifestPath: path.join(courseDir, 'manifest.json'), state, stopReason });
  videoAction.writeVideoLessonsIndex(courseDir, Object.values(state.lessons));
  await browser.close();

  return {
    ok: true,
    courseDir,
    lessons: Object.keys(state.lessons).length,
    stopReason,
  };
}

// ── Page helpers (shared by providers too if needed) ──────────────────────────

async function waitStable(page, timeoutMs) {
  const t = timeoutMs || 60000;
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: Math.min(t, 15000) }).catch(() => {});
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: Math.min(t, 8000) }).catch(() => {});
}

async function humanScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let scrolled = 0;
      const maxH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      function step() {
        if (scrolled >= maxH) { window.scrollTo({ top: 0 }); return resolve(); }
        const dy = 200 + Math.floor(Math.random() * 350);
        const pause = 80 + Math.floor(Math.random() * 200);
        window.scrollBy(0, dy);
        scrolled += dy;
        setTimeout(step, pause);
      }
      step();
    });
  });
  const { sleep } = require('../../core/utils');
  await sleep(300 + Math.random() * 500);
}

module.exports = { runScrape, waitStable, humanScroll };
