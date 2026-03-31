#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const provider = require('../src/providers/bytebytego');
const curriculum = require('../src/providers/bytebytego/lib/curriculum');
const { safeMkdir, writeJson, readJson } = require('../src/core/utils');
const {
  loadCourseFiles,
  ensureCourseState,
  hydrateStateFromManifest,
  computeResumePlan,
  updateLessonState,
  markLessonDone,
  writeManifestFromState,
  findNextLessonIndex,
} = require('../src/core/state');
const { readCourseMap, writeCourseMap, mergeCurriculum } = require('../src/core/course-map');

const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'user';
const MAX_RETRIES = Number(process.env.ALEX_XU_COURSE_RETRIES || 4);
const RETRY_DELAY_MS = Number(process.env.ALEX_XU_COURSE_RETRY_DELAY_MS || 2500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTrailingJson(stdout) {
  const trimmed = String(stdout || '').trim();
  const match = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!match) throw new Error(`No JSON found in output: ${trimmed.slice(0, 400)}`);
  return JSON.parse(match[1]);
}

function runOpenClaw(args, { json = true } = {}) {
  const fullArgs = ['browser', '--browser-profile', BROWSER_PROFILE];
  if (json) fullArgs.push('--json');
  fullArgs.push(...args);
  const stdout = execFileSync('openclaw', fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return json ? parseTrailingJson(stdout) : stdout;
}

async function retry(label, fn) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      console.error(`[retry:${label}] attempt ${attempt}/${MAX_RETRIES} failed: ${String(err?.message || err)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

function resolveOutDir(rawOutDir) {
  if (rawOutDir) return rawOutDir;
  if (process.env.CONTENT_ACQUISITION_OUT_DIR) return process.env.CONTENT_ACQUISITION_OUT_DIR;
  return provider.defaultOutputRoot();
}

async function findOrOpenTab(targetUrl) {
  const desired = provider.normalizeUrl(targetUrl);
  const tabs = await retry('tabs', async () => runOpenClaw(['tabs']));
  const tab = tabs.tabs?.find((t) => provider.normalizeUrl(t.url || '') === desired)
    || tabs.tabs?.find((t) => (t.url || '').includes('bytebytego.com'));
  if (tab) return tab.targetId;
  const opened = await retry('open', async () => runOpenClaw(['open', desired]));
  return opened.targetId;
}

async function waitForUrl(targetId, expectedUrl) {
  const desired = provider.normalizeUrl(expectedUrl);
  const initialTabs = await retry('tabs', async () => runOpenClaw(['tabs']));
  const initialTab = initialTabs.tabs?.find((t) => t.targetId === targetId);
  if (initialTab && provider.normalizeUrl(initialTab.url || '') === desired) return initialTab;

  await retry('navigate', async () => runOpenClaw(['navigate', desired, '--target-id', targetId]));
  for (let i = 0; i < 24; i++) {
    const tabs = await retry('tabs', async () => runOpenClaw(['tabs']));
    const tab = tabs.tabs?.find((t) => t.targetId === targetId);
    if (tab && provider.normalizeUrl(tab.url || '') === desired) return tab;
    await sleep(500);
  }
  throw new Error(`Tab ${targetId} did not reach ${desired}`);
}

async function extractHtml(targetId) {
  const fn = `() => ({
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML
  })`;
  const result = await retry('html', async () => runOpenClaw(['evaluate', '--target-id', targetId, '--fn', fn]));
  const payload = result.result || result;
  if (!payload?.html) throw new Error('Failed to extract HTML from current tab');
  return payload;
}

function discoverCurriculumFromCurrentHtml(html, ctx) {
  const nextData = curriculum.extractNextDataJson(html);
  if (nextData) {
    const result = curriculum.discoverCurriculumFromNextData(nextData, ctx);
    if (result?.orderedLessons?.length) return result;
  }
  throw new Error('Could not discover curriculum from current lesson HTML');
}

function ensureLessonDir(courseDir, index, url) {
  const lessonSlug = provider.lessonSlugFromUrl(url, `page-${index}`);
  const dir = `${String(index).padStart(2, '0')}-${lessonSlug}`;
  const lessonDir = path.join(courseDir, dir);
  safeMkdir(lessonDir);
  return { dir, lessonDir };
}

function hasValidPdf(pdfPath) {
  try {
    return fs.statSync(pdfPath).size > 20 * 1024;
  } catch {
    return false;
  }
}

async function renderLesson(url, lessonDir) {
  const stdout = execFileSync('node', [
    path.join(__dirname, 'alex_xu-existing-session-render.js'),
    url,
    lessonDir,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return parseTrailingJson(stdout);
}

function writeCourseMapFromCurriculum(courseDir, courseMap, curriculumResult) {
  mergeCurriculum(courseMap, curriculumResult, (u) => provider.normalizeUrl(u));
  writeCourseMap(courseDir, courseMap);
}

function sanitizeLoadedCourseData({ loaded, state, ctx }) {
  const isValidLessonUrl = (url) => {
    if (!url) return false;
    try {
      return provider.isCourseLessonUrl(provider.normalizeUrl(url), ctx);
    } catch {
      return false;
    }
  };

  const originalManifestLessons = Array.isArray(loaded.manifest?.lessons) ? [...loaded.manifest.lessons] : [];
  const originalStateEntries = Object.entries(state.lessons || {});
  const sanitizedManifestLessons = originalManifestLessons.filter((lesson) => isValidLessonUrl(lesson?.url));
  if (loaded.manifest && sanitizedManifestLessons.length !== originalManifestLessons.length) {
    loaded.manifest.lessons = sanitizedManifestLessons;
  }

  const sanitizedLessons = {};
  for (const [key, value] of originalStateEntries) {
    if (!isValidLessonUrl(key)) continue;
    sanitizedLessons[provider.normalizeUrl(key)] = value;
  }
  state.lessons = sanitizedLessons;

  if (!isValidLessonUrl(state.nextUrl)) state.nextUrl = null;
  if (!isValidLessonUrl(state.lastCompletedLessonKey)) state.lastCompletedLessonKey = null;

  return {
    removedManifestEntries: originalManifestLessons.length - sanitizedManifestLessons.length,
    removedStateEntries: originalStateEntries.length - Object.keys(state.lessons || {}).length,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let url = null;
  let outDir = null;
  let resume = true;
  let fromIndex = null;
  let toIndex = null;
  let continueAfterRange = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--url' && n) { url = n; i++; }
    else if (a === '--out-dir' && n) { outDir = n.replace(/^~/, process.env.HOME); i++; }
    else if (a === '--no-resume') { resume = false; }
    else if (a === '--from-index' && n) { fromIndex = Number(n); i++; }
    else if (a === '--to-index' && n) { toIndex = Number(n); i++; }
    else if (a === '--continue-after-range') { continueAfterRange = true; }
  }

  if (!url) {
    console.error('Usage: node scripts/alex_xu-existing-session-course.js --url <lesson-url> [--out-dir <path>] [--no-resume] [--from-index N --to-index M --continue-after-range]');
    process.exit(1);
  }

  if ((fromIndex != null && !Number.isFinite(fromIndex)) || (toIndex != null && !Number.isFinite(toIndex))) {
    throw new Error('from-index/to-index must be numbers');
  }

  if ((fromIndex == null) !== (toIndex == null)) {
    throw new Error('from-index and to-index must be provided together');
  }

  outDir = resolveOutDir(outDir);
  safeMkdir(outDir);

  const startUrl = provider.normalizeUrl(url);
  const ctx = provider.buildCourseContext(startUrl);
  const courseDir = path.join(outDir, ctx.courseSlug);
  safeMkdir(courseDir);

  const loaded = loadCourseFiles(courseDir);
  const state = ensureCourseState({ courseSlug: ctx.courseSlug, startUrl, courseDir, loaded });
  const courseMap = readCourseMap(courseDir);
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  const sanitized = sanitizeLoadedCourseData({ loaded, state, ctx });
  hydrateStateFromManifest({
    state,
    manifest: loaded.manifest,
    courseDir,
    normalizeUrl: (u) => provider.normalizeUrl(u),
  });

  const targetId = await findOrOpenTab(startUrl);
  const currentTab = await waitForUrl(targetId, startUrl);
  const htmlPayload = await extractHtml(targetId);
  const curriculumResult = discoverCurriculumFromCurrentHtml(htmlPayload.html, ctx);
  const orderedLessons = curriculumResult.orderedLessons || [];
  if (!orderedLessons.length) throw new Error('Curriculum discovery returned zero lessons');

  writeCourseMapFromCurriculum(courseDir, courseMap, curriculumResult);

  const resumePlan = resume !== false
    ? computeResumePlan({ state, manifest: loaded.manifest, startUrl, courseDir, normalizeUrl: (u) => provider.normalizeUrl(u) })
    : { mode: 'fresh', url: startUrl, skipCurrentDoneCheck: false };

  if (sanitized.removedManifestEntries > 0 || sanitized.removedStateEntries > 0) {
    writeJson(path.join(courseDir, '.resume-state.json'), state);
    writeManifestFromState({ manifestPath: loaded.manifestPath, state, stopReason: 'sanitized-invalid-lessons' });
    console.error(`[sanitize] removed invalid entries: manifest=${sanitized.removedManifestEntries} state=${sanitized.removedStateEntries}`);
  }

  let startIndex = 0;
  if (resumePlan.mode !== 'fresh') {
    const resumeUrl = provider.normalizeUrl(resumePlan.url);
    const found = orderedLessons.findIndex((lesson) => provider.normalizeUrl(lesson.url) === resumeUrl);
    if (found >= 0) startIndex = resumePlan.skipCurrentDoneCheck ? found + 1 : found;
  }

  const results = [];
  const rangeMode = fromIndex != null && toIndex != null;
  const normalizedFromIndex = rangeMode ? Math.min(fromIndex, toIndex) : null;
  const normalizedToIndex = rangeMode ? Math.max(fromIndex, toIndex) : null;

  for (let i = 0; i < orderedLessons.length; i++) {
    const lesson = orderedLessons[i];
    const lessonUrl = provider.normalizeUrl(lesson.url);
    const index = i + 1;
    const { dir, lessonDir } = ensureLessonDir(courseDir, index, lessonUrl);
    const pdfPath = path.join(lessonDir, 'page.pdf');
    const inForcedRange = rangeMode && index >= normalizedFromIndex && index <= normalizedToIndex;

    let shouldConsider = false;
    if (rangeMode) {
      if (inForcedRange) shouldConsider = true;
      else if (continueAfterRange && index > normalizedToIndex) shouldConsider = true;
    } else {
      shouldConsider = index >= (startIndex + 1);
    }
    if (!shouldConsider) continue;

    state.nextUrl = lessonUrl;
    state.lastRunAt = new Date().toISOString();
    updateLessonState(state, lessonUrl, {
      index,
      title: lesson.title,
      dir,
      status: 'partial',
    });
    writeJson(path.join(courseDir, '.resume-state.json'), state);
    writeManifestFromState({ manifestPath: loaded.manifestPath, state, stopReason: null });

    if (!inForcedRange && hasValidPdf(pdfPath)) {
      console.error(`[skip] lesson ${index} already has valid pdf → ${lessonUrl}`);
      markLessonDone({
        state,
        courseDir,
        lessonKey: lessonUrl,
        index,
        title: lesson.title,
        dir,
        hasVideo: false,
        videoSources: 0,
        videoDownloaded: 0,
        videoFiles: [],
      });
      writeJson(path.join(courseDir, '.resume-state.json'), state);
      writeManifestFromState({ manifestPath: loaded.manifestPath, state, stopReason: null });
      results.push({ index, url: lessonUrl, dir, skipped: true });
      continue;
    }

    console.error(`[lesson ${index}/${orderedLessons.length}] ${lesson.title} → ${lessonUrl}${inForcedRange ? ' [forced-rerun]' : ''}`);
    const rendered = await renderLesson(lessonUrl, lessonDir);

    markLessonDone({
      state,
      courseDir,
      lessonKey: lessonUrl,
      index,
      title: lesson.title,
      dir,
      hasVideo: false,
      videoSources: 0,
      videoDownloaded: 0,
      videoFiles: [],
    });
    state.nextUrl = orderedLessons[i + 1]?.url ? provider.normalizeUrl(orderedLessons[i + 1].url) : null;
    state.lastRunAt = new Date().toISOString();
    writeJson(path.join(courseDir, '.resume-state.json'), state);
    writeManifestFromState({ manifestPath: loaded.manifestPath, state, stopReason: null });
    results.push({ index, url: lessonUrl, dir, forced: inForcedRange, render: rendered.render || rendered });
  }

  writeManifestFromState({ manifestPath: loaded.manifestPath, state, stopReason: 'completed' });
  writeJson(path.join(courseDir, '.resume-state.json'), state);

  console.log(JSON.stringify({
    ok: true,
    targetId,
    currentTabUrl: currentTab.url,
    courseDir,
    totalLessons: orderedLessons.length,
    completed: results.length,
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
