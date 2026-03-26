'use strict';

const fs = require('fs');
const path = require('path');
const {
  safeMkdir,
  normalizeLessonUrl,
  hasValidPdf,
  fileSizeSafe,
} = require('./utils');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  safeMkdir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadCourseFiles(courseDir) {
  const manifestPath = path.join(courseDir, 'manifest.json');
  const statePath = path.join(courseDir, '.resume-state.json');
  return {
    manifestPath,
    statePath,
    manifest: readJson(manifestPath, null),
    state: readJson(statePath, null),
  };
}

function createEmptyState({ courseSlug, startUrl, courseDir }) {
  return {
    courseSlug,
    startUrl,
    courseDir,
    lastRunAt: null,
    nextUrl: null,
    lastCompletedLessonKey: null,
    lessons: {},
  };
}

function ensureCourseState({ courseSlug, startUrl, courseDir, loaded }) {
  const state = loaded.state || createEmptyState({ courseSlug, startUrl, courseDir });
  state.courseSlug = courseSlug;
  state.startUrl = startUrl;
  state.courseDir = courseDir;
  if (!state.lessons || typeof state.lessons !== 'object') state.lessons = {};
  return state;
}

function hydrateStateFromManifest({ state, manifest, courseDir }) {
  if (!manifest || !Array.isArray(manifest.lessons)) return state;
  for (const lesson of manifest.lessons) {
    const key = normalizeLessonUrl(lesson.url);
    const dir = lesson.dir;
    const pdfPath = path.join(courseDir, dir, 'page.pdf');
    const done = hasValidPdf(pdfPath);
    const existing = state.lessons[key] || {};
    state.lessons[key] = {
      index: lesson.index,
      title: lesson.title,
      url: key,
      dir,
      status: done ? 'done' : (existing.status || 'partial'),
      pdfPath: done ? path.relative(courseDir, pdfPath) : null,
      pdfSize: done ? fileSizeSafe(pdfPath) : 0,
      hasVideo: existing.hasVideo === true,
      videoSources: existing.videoSources || 0,
      videoDownloaded: existing.videoDownloaded || 0,
      videoFiles: existing.videoFiles || [],
      updatedAt: existing.updatedAt || manifest.startedAt || new Date().toISOString(),
    };
  }
  return state;
}

function computeResumePlan({ state, manifest, startUrl, courseDir }) {
  const normalizeIf = (value) => (value ? normalizeLessonUrl(value) : null);
  const nextUrl = normalizeIf(state.nextUrl);
  if (nextUrl) {
    const existing = state.lessons[nextUrl];
    const pdfPath = existing?.dir ? path.join(courseDir, existing.dir, 'page.pdf') : null;
    if (!pdfPath || !hasValidPdf(pdfPath)) {
      return { mode: 'resume-next-url', url: nextUrl, skipCurrentDoneCheck: false };
    }
  }

  const lessons = Array.isArray(manifest?.lessons) ? manifest.lessons : [];
  let lastDone = null;
  for (const lesson of lessons) {
    const key = normalizeLessonUrl(lesson.url);
    const entry = state.lessons[key];
    const pdfPath = entry?.dir ? path.join(courseDir, entry.dir, 'page.pdf') : path.join(courseDir, lesson.dir, 'page.pdf');
    if (hasValidPdf(pdfPath)) lastDone = { ...lesson, url: key };
    else break;
  }

  if (lastDone) {
    return { mode: 'resume-after-last-done', url: lastDone.url, skipCurrentDoneCheck: true };
  }

  return { mode: 'fresh', url: normalizeLessonUrl(startUrl), skipCurrentDoneCheck: false };
}

function findNextLessonIndex(state, options = {}) {
  const coursePrefix = typeof options.coursePrefix === 'string' ? options.coursePrefix : '';
  const indexes = Object.values(state.lessons)
    .filter((lesson) => {
      if (!coursePrefix) return true;
      return typeof lesson.url === 'string' && lesson.url.includes(coursePrefix);
    })
    .map((lesson) => Number(lesson.index) || 0)
    .filter((n) => n > 0);
  return (indexes.length ? Math.max(...indexes) : 0) + 1;
}

function updateLessonState(state, lessonKey, patch) {
  const existing = state.lessons[lessonKey] || {};
  state.lessons[lessonKey] = {
    ...existing,
    ...patch,
    url: lessonKey,
    updatedAt: new Date().toISOString(),
  };
}

function markLessonDone({ state, courseDir, lessonKey, index, title, dir, hasVideo, videoSources, videoDownloaded, videoFiles }) {
  const pdfPath = path.join(courseDir, dir, 'page.pdf');
  updateLessonState(state, lessonKey, {
    index,
    title,
    dir,
    status: hasValidPdf(pdfPath) ? 'done' : 'partial',
    pdfPath: hasValidPdf(pdfPath) ? path.relative(courseDir, pdfPath) : null,
    pdfSize: fileSizeSafe(pdfPath),
    hasVideo: Boolean(hasVideo),
    videoSources: videoSources || 0,
    videoDownloaded: videoDownloaded || 0,
    videoFiles: videoFiles || [],
  });
  state.lastCompletedLessonKey = lessonKey;
}

function writeManifestFromState({ manifestPath, state, stopReason }) {
  const lessons = Object.values(state.lessons)
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((lesson) => ({
      index: lesson.index,
      title: lesson.title,
      url: lesson.url,
      dir: lesson.dir,
      status: lesson.status,
      hasVideo: lesson.hasVideo || false,
      videoSources: lesson.videoSources || 0,
      videoDownloaded: lesson.videoDownloaded || 0,
      videoFiles: lesson.videoFiles || [],
    }));
  writeJson(manifestPath, {
    courseSlug: state.courseSlug,
    startedAt: state.startedAt || new Date().toISOString(),
    startUrl: state.startUrl,
    courseDir: state.courseDir,
    lessons,
    nextUrl: state.nextUrl,
    lastCompletedLessonKey: state.lastCompletedLessonKey,
    lastRunAt: state.lastRunAt,
    stopReason: stopReason || null,
  });
}

module.exports = {
  loadCourseFiles,
  ensureCourseState,
  hydrateStateFromManifest,
  computeResumePlan,
  findNextLessonIndex,
  updateLessonState,
  markLessonDone,
  writeJson,
  writeManifestFromState,
};
