'use strict';

/**
 * core/utils.js — shared low-level helpers, provider-agnostic.
 */

const fs = require('fs');
const path = require('path');

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function slugify(str) {
  return String(str || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'page';
}

function fileSizeSafe(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function hasValidPdf(file, minBytes = 20 * 1024) {
  try {
    return fs.existsSync(file) && fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

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

module.exports = {
  safeMkdir,
  sleep,
  randomBetween,
  formatMs,
  slugify,
  fileSizeSafe,
  hasValidPdf,
  listFilesRecursive,
  readJson,
  writeJson,
};
