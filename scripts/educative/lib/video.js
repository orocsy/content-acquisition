'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { listFilesRecursive } = require('./utils');

function createCapturedVideoSet(page) {
  const captured = new Set();
  page.on('request', (req) => {
    const url = req.url();
    if (/\.m3u8|\.mpd|\/hls\/|\/playlist\.m3u/i.test(url) ||
        /(?:bunny\.net|cloudfront\.net|jwplayer|mux\.com|jwpcdn).*(?:video|stream|media)/i.test(url)) {
      captured.add(url);
    }
    req.continue();
  });
  return captured;
}

function extractInlineVideoUrls(rawHtml) {
  const urls = [];
  const iframeRe = /(?:src|data-src)=["'](https?:\/\/[^"']*(?:youtube\.com\/embed|youtu\.be|player\.vimeo\.com|jwplayer|bunny\.net|mux\.com)[^"']*)/gi;
  let match;
  while ((match = iframeRe.exec(rawHtml))) urls.push(match[1]);
  return [...new Set(urls)];
}

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
