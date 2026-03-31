'use strict';

const { normalizeLessonUrl } = require('./utils');

const URL_KEYS = ['url', 'href', 'path', 'pathname', 'permalink', 'link', 'canonicalUrl', 'canonical_url'];
const SLUG_KEYS = ['slug', 'pageSlug', 'page_slug', 'lessonSlug', 'lesson_slug', 'articleSlug', 'article_slug'];
const TITLE_KEYS = ['title', 'name', 'label', 'heading', 'headline', 'seoTitle', 'seo_title', 'text', 'moduleTitle', 'module_title', 'sectionTitle', 'section_title'];
const STRONG_COLLECTION_RE = /(^|\.)(toc|tableofcontents|curriculum|outline|chapters|lessons|sections|modules)(\.|$)/i;
const SECTION_KEY_RE = /(chapter|section|module|unit|category|group)/i;
const COLLECTION_KEY_RE = /(toc|table.?of.?contents|curriculum|outline|chapter|section|lesson|module|article|post|page|item|child|node|content)/i;

function normalizeCourseRootUrl(courseRootUrl) {
  return normalizeLessonUrl(courseRootUrl);
}

function extractNextDataJson(html) {
  const match = String(html || '').match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function pickFirstString(node, keys) {
  for (const key of keys) {
    if (typeof node?.[key] === 'string' && node[key].trim()) return node[key].trim();
  }
  return null;
}

function pickNodeTitle(node) {
  return pickFirstString(node, TITLE_KEYS);
}

function looksLikeRelativePath(value) {
  return /^[a-z0-9][a-z0-9/_-]*$/i.test(value);
}

function resolveMaybeUrl(raw, ctx) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /^(javascript:|mailto:|tel:|#)/i.test(value)) return null;

  try {
    if (/^https?:\/\//i.test(value)) return normalizeLessonUrl(value);
    if (value.startsWith('/')) return normalizeLessonUrl(new URL(value, ctx.origin).toString());
    if (value.startsWith('./') || value.startsWith('../')) {
      return normalizeLessonUrl(new URL(value, `${ctx.courseRootUrl}/`).toString());
    }
    if (looksLikeRelativePath(value)) {
      const lessonPrefix = ctx.lessonPrefix || ctx.coursePrefix;
      const relative = value.startsWith(lessonPrefix.replace(/^\//, ''))
        ? `/${value.replace(/^\/+/, '')}`
        : value.startsWith(ctx.coursePrefix.replace(/^\//, ''))
        ? `/${value.replace(/^\/+/, '')}`
        : `${lessonPrefix}${value.replace(/^\/+/, '')}`;
      return normalizeLessonUrl(new URL(relative, ctx.origin).toString());
    }
  } catch {}

  return null;
}

const INVALID_COURSE_URL_RE = /\/(?:login|signup|sign-up|pricing|checkout|auth)(?:\/|$)/i;

function isWithinCourse(url, ctx) {
  if (!url) return false;
  try {
    const normalized = normalizeLessonUrl(url);
    const pathname = new URL(normalized).pathname;
    if (!pathname.startsWith(ctx.coursePrefix)) return false;
    if (normalized === normalizeCourseRootUrl(ctx.courseRootUrl)) return false;
    if (INVALID_COURSE_URL_RE.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function hasNestedCollections(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  return Object.entries(node).some(([key, value]) => {
    if (!value || typeof value !== 'object') return false;
    if (COLLECTION_KEY_RE.test(key)) return true;
    return Array.isArray(value) && value.some((entry) => entry && typeof entry === 'object');
  });
}

function extractLessonCandidate(node, ctx, sectionPath, pathKeys) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;

  let url = null;
  for (const key of URL_KEYS) {
    url = resolveMaybeUrl(node[key], ctx);
    if (url) break;
  }

  if (!url) {
    const slug = pickFirstString(node, SLUG_KEYS);
    if (slug) url = resolveMaybeUrl(slug, ctx);
  }

  if (!isWithinCourse(url, ctx)) return null;

  const title = pickNodeTitle(node)
    || pickFirstString(node, SLUG_KEYS)
    || new URL(url).pathname.split('/').filter(Boolean).pop();

  return {
    url: normalizeLessonUrl(url),
    title,
    slug: pickFirstString(node, SLUG_KEYS),
    sectionPath: [...sectionPath],
  };
}

function extendSectionPath(node, sectionPath, pathKeys, lesson) {
  const label = pickNodeTitle(node);
  if (!label || lesson) return sectionPath;

  const lastKey = pathKeys[pathKeys.length - 1] || '';
  const groupType = typeof node?.type === 'string' ? node.type : '';
  if (SECTION_KEY_RE.test(lastKey) || SECTION_KEY_RE.test(groupType) || hasNestedCollections(node)) {
    return [...sectionPath, label];
  }
  return sectionPath;
}

function flattenLessonSequence(value, ctx, sectionPath = [], pathKeys = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenLessonSequence(entry, ctx, sectionPath, pathKeys));
  }
  if (!value || typeof value !== 'object') return [];

  const lesson = extractLessonCandidate(value, ctx, sectionPath, pathKeys);
  const nextSectionPath = extendSectionPath(value, sectionPath, pathKeys, lesson);

  const nested = [];
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    nested.push(...flattenLessonSequence(child, ctx, nextSectionPath, [...pathKeys, key]));
  }

  if (!lesson) return nested;
  if (!nested.some((entry) => entry.url === lesson.url)) return [lesson, ...nested];
  return nested;
}

function collectNamedSequences(value, ctx, pathKeys = [], out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectNamedSequences(entry, ctx, pathKeys, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathKeys, key];
    if (child && typeof child === 'object' && COLLECTION_KEY_RE.test(key)) {
      const lessons = dedupeLessons(flattenLessonSequence(child, ctx, [], nextPath));
      if (lessons.length >= 2) out.push({ pathKeys: nextPath, lessons });
    }
    collectNamedSequences(child, ctx, nextPath, out);
  }

  return out;
}

function collectArraySequences(value, ctx, sectionPath = [], pathKeys = [], out = []) {
  if (Array.isArray(value)) {
    const lessons = dedupeLessons(value.flatMap((entry) => flattenLessonSequence(entry, ctx, sectionPath, pathKeys)));
    if (lessons.length >= 2) out.push({ pathKeys, lessons });
    for (const entry of value) collectArraySequences(entry, ctx, sectionPath, pathKeys, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const lesson = extractLessonCandidate(value, ctx, sectionPath, pathKeys);
  const nextSectionPath = extendSectionPath(value, sectionPath, pathKeys, lesson);

  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue;
    collectArraySequences(child, ctx, nextSectionPath, [...pathKeys, key], out);
  }

  return out;
}

function scoreSequence(sequence) {
  const path = sequence.pathKeys.join('.');
  let score = sequence.lessons.length * 10;
  if (STRONG_COLLECTION_RE.test(path)) score += 200;
  if (COLLECTION_KEY_RE.test(path)) score += 50;
  score += [...new Set(sequence.lessons.flatMap((lesson) => lesson.sectionPath || []))].length * 5;
  return score;
}

function dedupeLessons(lessons) {
  const seen = new Set();
  const out = [];
  for (const lesson of lessons || []) {
    if (!lesson?.url) continue;
    const normalized = normalizeLessonUrl(lesson.url);
    try {
      const pathname = new URL(normalized).pathname;
      if (INVALID_COURSE_URL_RE.test(pathname)) continue;
    } catch {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ ...lesson, url: normalized });
  }
  return out;
}

function headingsFromLessons(lessons) {
  const headings = [];
  for (const lesson of lessons || []) {
    const heading = lesson.sectionPath?.[0];
    if (heading && !headings.includes(heading)) headings.push(heading);
  }
  return headings;
}

function buildTocTree(lessons) {
  const root = [];

  for (const lesson of lessons || []) {
    let cursor = root;
    for (const label of lesson.sectionPath || []) {
      if (!label) continue;
      let section = cursor.find((entry) => entry.kind === 'section' && entry.title === label);
      if (!section) {
        section = { kind: 'section', title: label, children: [] };
        cursor.push(section);
      }
      cursor = section.children;
    }

    cursor.push({
      kind: 'lesson',
      title: lesson.title,
      url: lesson.url,
      slug: lesson.slug || null,
    });
  }

  return root;
}

function buildLessonsFromExplicitToc(nextData, ctx) {
  const pageProps = nextData?.props?.pageProps || {};
  const toc = Array.isArray(pageProps.toc) ? pageProps.toc : [];
  const courseKey = pageProps.course || pageProps.courseMetadata?.key || ctx.courseSlug;

  return dedupeLessons(toc.map((entry) => {
    let url = null;
    if (Array.isArray(entry?.slug) && entry.slug.length > 0) {
      url = `${ctx.origin}/courses/${courseKey}/${entry.slug.map((part) => String(part || '').replace(/^\/+|\/+$/g, '')).join('/')}`;
    } else if (typeof entry?.id === 'string' && entry.id.trim()) {
      url = `${ctx.origin}/courses/${courseKey}/${entry.id.replace(/^\/+|\/+$/g, '')}`;
    } else if (typeof entry?.path === 'string' && entry.path.trim()) {
      url = resolveMaybeUrl(entry.path, ctx);
    }

    const chapterGroup = typeof entry?.subsection === 'string' && entry.subsection.trim()
      ? [entry.subsection.trim()]
      : [];

    return {
      url,
      title: entry?.title || entry?.name || entry?.label || entry?.id || 'Lesson',
      slug: Array.isArray(entry?.slug) ? entry.slug.join('/') : (entry?.id || null),
      sectionPath: chapterGroup,
      chapter: entry?.chapter || null,
      difficulty: entry?.difficulty || null,
      free: entry?.free ?? null,
    };
  }).filter((lesson) => isWithinCourse(lesson.url, ctx)));
}

function discoverCurriculumFromNextData(nextData, ctx) {
  const explicitTocLessons = buildLessonsFromExplicitToc(nextData, ctx);
  const namedSequences = collectNamedSequences(nextData, ctx).sort((a, b) => scoreSequence(b) - scoreSequence(a));
  const arraySequences = collectArraySequences(nextData, ctx).sort((a, b) => scoreSequence(b) - scoreSequence(a));
  const bestNamed = namedSequences[0]?.lessons || [];
  const bestArray = arraySequences[0]?.lessons || [];
  const fallback = dedupeLessons(flattenLessonSequence(nextData, ctx));
  const orderedLessons = explicitTocLessons.length >= 2
    ? explicitTocLessons
    : bestNamed.length >= 2
    ? bestNamed
    : bestArray.length >= 2
    ? bestArray
    : fallback;
  const source = explicitTocLessons.length >= 2
    ? 'next-data-explicit-toc'
    : bestNamed.length >= 2
    ? 'next-data-toc'
    : bestArray.length >= 2
    ? 'next-data-array'
    : 'next-data-fallback';

  return {
    source,
    courseRootUrl: normalizeCourseRootUrl(ctx.courseRootUrl),
    title: pickNodeTitle(nextData?.props?.pageProps?.courseMetadata) || pickNodeTitle(nextData?.props?.pageProps) || ctx.courseSlug,
    headings: headingsFromLessons(orderedLessons),
    tocTree: buildTocTree(orderedLessons),
    orderedLessons,
  };
}

async function discoverCurriculumFromHtml(page, ctx) {
  const result = await page.evaluate((coursePrefix) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const roots = [
      ...document.querySelectorAll('aside, nav, [role="navigation"], [class*="sidebar"], [class*="toc"], [class*="curriculum"], [class*="outline"], [data-testid*="sidebar"]'),
    ];
    const anchorPool = roots.length
      ? roots.flatMap((root) => [...root.querySelectorAll('a[href]')])
      : [...document.querySelectorAll('a[href]')];

    const rows = anchorPool.map((a, domIndex) => {
      const href = a.href || a.getAttribute('href') || '';
      const text = normalize(a.innerText || a.textContent || '');
      const sectionPath = [];
      let node = a.closest('li, section, article, details, div');
      while (node && sectionPath.length < 4) {
        const label = normalize(
          node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > summary, :scope > [role="heading"]')?.innerText || '',
        );
        if (label && label !== text && !sectionPath.includes(label)) sectionPath.unshift(label);
        node = node.parentElement?.closest('li, section, article, details, div') || null;
      }
      return { href, text, domIndex, sectionPath };
    }).filter((row) => row.href && row.href.includes(coursePrefix));

    return {
      title: document.title || '',
      headings: [...document.querySelectorAll('h1,h2,h3')].map((el) => (el.innerText || '').trim()).filter(Boolean).slice(0, 20),
      rows,
    };
  }, ctx.coursePrefix);

  const orderedLessons = dedupeLessons(
    result.rows
      .sort((a, b) => a.domIndex - b.domIndex)
      .map((row) => ({
        url: row.href,
        title: row.text || new URL(row.href).pathname.split('/').filter(Boolean).pop(),
        sectionPath: row.sectionPath || [],
      })),
  ).filter((lesson) => isWithinCourse(lesson.url, ctx));

  return {
    source: 'html-structure',
    courseRootUrl: normalizeCourseRootUrl(ctx.courseRootUrl),
    title: result.title || ctx.courseSlug,
    headings: result.headings,
    tocTree: buildTocTree(orderedLessons),
    orderedLessons,
  };
}

function findNextLessonInCurriculum(orderedLessons, currentUrl, visitedUrls = new Set()) {
  const normalizedCurrent = normalizeLessonUrl(currentUrl);
  const urls = (orderedLessons || []).map((lesson) => normalizeLessonUrl(lesson.url));
  const idx = urls.indexOf(normalizedCurrent);

  if (idx >= 0) {
    for (let i = idx + 1; i < urls.length; i++) {
      if (!visitedUrls.has(urls[i])) return urls[i];
    }
    return null;
  }

  for (const url of urls) {
    if (url !== normalizedCurrent && !visitedUrls.has(url)) return url;
  }
  return null;
}

module.exports = {
  extractNextDataJson,
  discoverCurriculumFromNextData,
  discoverCurriculumFromHtml,
  findNextLessonInCurriculum,
};
