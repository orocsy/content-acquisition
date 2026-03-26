'use strict';

/**
 * dispatch/actions/video.js — video capture action.
 *
 * Three helpers:
 *   createCapturedVideoSet(page)   — intercepts network requests to capture stream URLs
 *   extractInlineVideoUrls(html)   — parses raw HTML for iframe/embed video URLs
 *   downloadVideo(url, mediaDir)   — downloads via yt-dlp
 *   writeVideoLessonsIndex(dir, lessons) — writes video-lessons.json summary
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { listFilesRecursive } = require('../../core/utils');

/**
 * Intercept network requests and collect streaming media URLs.
 * Returns a Set that is mutated in place as requests arrive.
 *
 * @param {object} page - Puppeteer page (request interception must be enabled)
 * @param {object} [provider] - optional provider for custom URL matching
 * @returns {Set<string>}
 */
function createCapturedVideoSet(page, provider) {
  const captured = new Set();
  const customMatcher = provider && typeof provider.matchVideoRequest === 'function'
    ? provider.matchVideoRequest.bind(provider)
    : null;

  page.on('request', (req) => {
    const url = req.url();
    const isVideo = customMatcher
      ? customMatcher(url)
      : /\.m3u8|\.mpd|\/hls\/|\/playlist\.m3u/i.test(url) ||
        /(?:bunny\.net|cloudfront\.net|jwplayer|mux\.com|jwpcdn).*(?:video|stream|media)/i.test(url);
    if (isVideo) captured.add(url);
    req.continue();
  });

  return captured;
}

/**
 * Parse inline video URLs from raw HTML.
 * @param {string} rawHtml
 * @returns {string[]}
 */
function extractInlineVideoUrls(rawHtml) {
  const urls = [];
  const iframeRe = /(?:src|data-src)=["'](https?:\/\/[^"']*(?:youtube\.com\/embed|youtu\.be|player\.vimeo\.com|jwplayer|bunny\.net|mux\.com)[^"']*)/gi;
  let match;
  while ((match = iframeRe.exec(rawHtml))) urls.push(match[1]);
  return [...new Set(urls)];
}

/**
 * Download a video URL to mediaDir using yt-dlp.
 * @param {string} videoUrl
 * @param {string} mediaDir
 * @returns {{ ok: bool, files: string[] }}
 */
function downloadVideo(videoUrl, mediaDir) {
  const before = new Set(listFilesRecursive(mediaDir));
  const res = spawnSync(
    'yt-dlp',
    [
      '--no-playlist',
      '--concurrent-fragments', '4',
      '--merge-output-format', 'mp4',
      '--max-filesize', '1g',
      '--quiet', '--no-warnings',
      '-o', path.join(mediaDir, '%(title).80s.%(ext)s'),
      videoUrl,
    ],
    { timeout: 300000 }
  );
  const after = listFilesRecursive(mediaDir).filter((f) => !before.has(f));
  return {
    ok: res.status === 0,
    files: after.map((f) => path.basename(f)),
  };
}

/**
 * Write video-lessons.json index for the course.
 * @param {string} courseDir
 * @param {object[]} lessons
 */
function writeVideoLessonsIndex(courseDir, lessons) {
  const onlyVideoLessons = lessons
    .filter((lesson) => lesson.hasVideo)
    .map((lesson) => ({
      index: lesson.index,
      title: lesson.title,
      url: lesson.url,
      dir: lesson.dir,
      videoSources: lesson.videoSources || 0,
      videoDownloaded: lesson.videoDownloaded || 0,
      videoFiles: lesson.videoFiles || [],
    }));
  fs.writeFileSync(
    path.join(courseDir, 'video-lessons.json'),
    JSON.stringify({ count: onlyVideoLessons.length, lessons: onlyVideoLessons }, null, 2)
  );
}

module.exports = {
  createCapturedVideoSet,
  extractInlineVideoUrls,
  downloadVideo,
  writeVideoLessonsIndex,
};
