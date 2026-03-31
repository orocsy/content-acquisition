'use strict';

/**
 * core/course-map.js — provider-agnostic course graph/curriculum cache.
 *
 * Persists to <courseDir>/course-map.json.
 * Providers may extend this with their own fields but the core shape is stable.
 */

const path = require('path');
const fs = require('fs');

function readCourseMap(courseDir) {
  const file = path.join(courseDir, 'course-map.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { nodes: {}, discoveredAt: null, updatedAt: null };
  }
}

function writeCourseMap(courseDir, map) {
  const file = path.join(courseDir, 'course-map.json');
  map.updatedAt = new Date().toISOString();
  if (!map.discoveredAt) map.discoveredAt = map.updatedAt;
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

function ensureNode(map, url, normalizeUrl) {
  const key = normalizeUrl(url);
  if (!map.nodes[key]) {
    map.nodes[key] = {
      url: key,
      titles: [],
      linksTo: [],
      linkedFrom: [],
      seenAt: [],
      notes: [],
      sourceHints: {},
    };
  }
  return map.nodes[key];
}

function pushUnique(arr, value) {
  if (!value) return;
  if (!arr.includes(value)) arr.push(value);
}

function mergePageDiscovery(map, discovery, normalizeUrl) {
  const node = ensureNode(map, discovery.url, normalizeUrl);
  if (discovery.title) pushUnique(node.titles, discovery.title);
  pushUnique(node.seenAt, new Date().toISOString());
  if (discovery.pageType) node.pageType = discovery.pageType;
  if (discovery.coursePrefix) node.coursePrefix = discovery.coursePrefix;

  for (const candidate of discovery.lessonCandidates || []) {
    const to = normalizeUrl(candidate.url);
    if (to === node.url) continue;
    const target = ensureNode(map, to, normalizeUrl);
    pushUnique(node.linksTo, to);
    pushUnique(target.linkedFrom, node.url);
    if (candidate.text) {
      if (!node.sourceHints[to]) node.sourceHints[to] = [];
      pushUnique(node.sourceHints[to], candidate.text);
    }
  }
  return map;
}

function findNextFromMap(map, currentUrl, visitedSet, normalizeUrl) {
  const key = normalizeUrl(currentUrl);
  const node = map.nodes[key];
  if (!node) return null;
  for (const to of node.linksTo || []) {
    if (!visitedSet.has(to)) return to;
  }
  return null;
}

function mergeCurriculum(map, curriculum, normalizeUrl) {
  map.curriculum = {
    source: curriculum.source,
    courseRootUrl: curriculum.courseRootUrl,
    title: curriculum.title,
    headings: curriculum.headings || [],
    tocTree: curriculum.tocTree || [],
    orderedLessons: curriculum.orderedLessons || [],
    updatedAt: new Date().toISOString(),
  };
  for (const lesson of curriculum.orderedLessons || []) {
    ensureNode(map, lesson.url, normalizeUrl);
  }
  return map;
}

module.exports = {
  readCourseMap,
  writeCourseMap,
  mergePageDiscovery,
  mergeCurriculum,
  findNextFromMap,
};
