'use strict';

/**
 * dispatch/actions/patch.js — post-scrape patch flow.
 *
 * Re-processes already-captured lessons without re-navigating the full course.
 * Useful for re-generating PDFs, re-downloading failed videos, or adding new
 * metadata to existing lesson directories.
 *
 * Options:
 *   provider     — provider instance
 *   courseDir    — path to captured course directory
 *   filter       — optional fn(lesson) → bool to limit which lessons are patched
 *   actions      — list of actions: pdf, video, interactive
 *   includeIncomplete — when false, only lessons with an existing valid PDF are patched
 *   timeoutMs    — navigation timeout
 *   headless     — bool
 *   executablePath
 *
 * This is a lighter-weight flow than scrape: it navigates directly to each
 * lesson URL using the manifest, patches what's missing, and moves on.
 */

const path = require('path');
const { hasValidPdf, writeJson, safeMkdir } = require('../../core/utils');
const { loadCourseFiles, markLessonDone, writeManifestFromState } = require('../../core/state');
const pdfAction = require('./pdf');
const videoAction = require('./video');
const interactiveAction = require('./interactive');

async function runPatch(opts) {
  const { provider } = opts;
  const courseDir = opts.courseDir;
  const loaded = loadCourseFiles(courseDir);

  if (!loaded.manifest || !Array.isArray(loaded.manifest.lessons)) {
    throw new Error(`No manifest.json found in ${courseDir}`);
  }

  const state = loaded.state || { lessons: {}, courseDir };
  if (!state.lessons) state.lessons = {};

  const actionSet = new Set(opts.actions || ['pdf', 'video', 'interactive']);
  const lessons = loaded.manifest.lessons.filter((lesson) => {
    if (typeof opts.filter === 'function' && !opts.filter(lesson)) return false;
    if (opts.includeIncomplete) return true;
    const pdfPath = path.join(courseDir, lesson.dir, 'page.pdf');
    return hasValidPdf(pdfPath);
  });
  console.error(`[patch] ${lessons.length} lesson(s) to patch in ${courseDir}`);

  if (lessons.length === 0) {
    return { ok: true, patched: 0 };
  }

  const { browser, page } = await provider.setupBrowser({
    headless: opts.headless !== false,
    executablePath: opts.executablePath,
  });
  await page.setRequestInterception(true);
  const capturedVideos = videoAction.createCapturedVideoSet(page, provider);
  await provider.applyStealthPatches(page);
  await provider.applyAuth(page, loaded.manifest.startUrl);
  page.setDefaultTimeout(opts.timeoutMs || 60000);

  let patched = 0;
  for (const lesson of lessons) {
    const lessonDir = path.join(courseDir, lesson.dir);
    const pdfPath = path.join(lessonDir, 'page.pdf');
    const needsPdf = actionSet.has('pdf') && !hasValidPdf(pdfPath);
    const needsVideo = actionSet.has('video') && lesson.hasVideo && lesson.videoDownloaded === 0;
    const needsInteractive = actionSet.has('interactive');

    if (!needsPdf && !needsVideo && !needsInteractive) {
      console.error(`[patch] skip ${lesson.url} (nothing to do)`);
      continue;
    }

    console.error(`[patch] ${lesson.url}`);
    await page.goto(lesson.url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: opts.timeoutMs || 60000 });
    await provider.assertPageAccess(page, {
      stage: 'patch',
      lessonUrl: lesson.url,
      currentUrl: provider.normalizeUrl(page.url()),
      timeoutMs: opts.timeoutMs,
    });

    if (needsPdf) {
      safeMkdir(lessonDir);
      await pdfAction.capturePdf(page, pdfPath);
    }

    let videoDownloaded = lesson.videoDownloaded || 0;
    const videoFiles = [...(lesson.videoFiles || [])];
    if (needsVideo) {
      const rawHtml = await page.content();
      const videoSourceUrls = [...new Set([
        ...capturedVideos,
        ...videoAction.extractInlineVideoUrls(rawHtml),
      ])];
      capturedVideos.clear();
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

    if (needsInteractive) {
      const mediaDir = path.join(lessonDir, 'media');
      safeMkdir(mediaDir);
      const captures = await interactiveAction.captureInteractiveWidgets(page, mediaDir, { perSlideDelayMs: 30000 });
      if (captures.length > 0) {
        console.error(`[patch] interactive ${captures.length} widget(s) captured for ${lesson.url}`);
      }
    }

    markLessonDone({
      state,
      courseDir,
      lessonKey: lesson.url,
      index: lesson.index,
      title: lesson.title,
      dir: lesson.dir,
      hasVideo: lesson.hasVideo,
      videoSources: lesson.videoSources || 0,
      videoDownloaded,
      videoFiles: [...new Set(videoFiles)],
    });

    writeJson(path.join(courseDir, '.resume-state.json'), state);
    writeManifestFromState({ manifestPath: path.join(courseDir, 'manifest.json'), state, stopReason: null });
    patched += 1;
  }

  videoAction.writeVideoLessonsIndex(courseDir, Object.values(state.lessons));
  await browser.close();

  return { ok: true, patched };
}

module.exports = { runPatch };
