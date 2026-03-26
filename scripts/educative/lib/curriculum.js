'use strict';

const { normalizeLessonUrl } = require('./utils');

function normalizeCourseRootFromPrefix(coursePrefix) {
  return `https://www.educative.io${coursePrefix.slice(0, -1)}`;
}

function pageUrlFromLessonSlug(coursePrefix, slug) {
  return `https://www.educative.io${coursePrefix}${slug}`;
}

function pushLessonPage(out, page, coursePrefix, sectionPath) {
  if (!page || !page.slug) return;
  out.push({
    url: normalizeLessonUrl(pageUrlFromLessonSlug(coursePrefix, page.slug)),
    title: page.title || page.slug,
    slug: page.slug,
    type: page.type,
    sectionPath,
    authorId: page.author_id,
    collectionId: page.collection_id,
    pageId: page.page_id,
    isPreview: Boolean(page.is_preview),
  });
}

function flattenTocCategories(categories, coursePrefix, out = [], sectionPath = []) {
  for (const category of categories || []) {
    const nextSectionPath = category && category.title && category.title !== '__default'
      ? [...sectionPath, category.title]
      : [...sectionPath];

    for (const page of category.pages || []) {
      pushLessonPage(out, page, coursePrefix, nextSectionPath);
    }

    for (const tocEntry of category.toc || []) {
      const tocSectionPath = tocEntry && tocEntry.title && tocEntry.title !== '__default'
        ? [...nextSectionPath, tocEntry.title]
        : [...nextSectionPath];

      for (const page of tocEntry.pages || []) {
        pushLessonPage(out, page, coursePrefix, tocSectionPath);
      }
    }
  }
  return out;
}

function isWithinCourse(url, coursePrefix) {
  try {
    const normalized = normalizeLessonUrl(url);
    return normalized.includes(coursePrefix) && !/\/blog\//i.test(normalized) && !/\/answers\//i.test(normalized);
  } catch {
    return false;
  }
}

async function discoverCurriculumFromPalApi(page, coursePrefix) {
  const current = await page.evaluate(() => ({
    path: location.pathname,
  }));
  const parts = current.path.split('/').filter(Boolean);
  const courseSlug = parts[1];
  const pageSlug = parts[2];

  if (!courseSlug || !pageSlug) {
    throw new Error(`Could not infer course/page slug from path: ${current.path}`);
  }

  const apiResult = await page.evaluate(async ({ courseSlugInner, pageSlugInner }) => {
    const res = await fetch(`/api/interview-prep/collection/${courseSlugInner}/page/${pageSlugInner}?work_type=module`, { credentials: 'include' });
    const json = await res.json();
    return { status: res.status, json };
  }, { courseSlugInner: courseSlug, pageSlugInner: pageSlug });

  if (apiResult.status !== 200 || !apiResult.json) {
    throw new Error(`Collection API returned status ${apiResult.status}`);
  }

  const details = apiResult.json?.instance?.details || {};
  const categories = details?.toc?.categories || [];
  const orderedLessons = flattenTocCategories(categories, coursePrefix, []);

  return {
    source: 'collection-page-api',
    courseRootUrl: normalizeCourseRootFromPrefix(coursePrefix),
    title: details.title || courseSlug,
    headings: categories.map((c) => c.title).filter(Boolean),
    authorId: Number(details.path_author_id || apiResult.json?.path_author_id || 0),
    pathId: Number(details.path_id || apiResult.json?.path_id || 0),
    orderedLessons,
    rawCategoryCount: categories.length,
    currentContentIndex: apiResult.json?.current_content_index,
    nextContentTitle: apiResult.json?.next_content_title,
  };
}

async function clickLikelyMiniMap(page) {
  return await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const scored = els.map((el, idx) => {
      const text = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const hay = text.toLowerCase();
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      let score = 0;
      if (/mini map/.test(hay)) score += 200;
      if (/outline|curriculum|course map|contents|table of contents/.test(hay)) score += 120;
      if (/map/.test(hay)) score += 60;
      if (!visible) score -= 1000;
      return { idx, score };
    }).filter((x) => x.score > 0).sort((a,b) => b.score - a.score);
    if (!scored.length) return false;
    const el = els[scored[0].idx];
    el.click();
    return true;
  });
}

async function expandLikelyCurriculumTree(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };

    for (let pass = 0; pass < 4; pass++) {
      const els = [...document.querySelectorAll('button, [role="button"], summary')];
      let clicked = 0;
      for (const el of els) {
        const text = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        const hay = text.toLowerCase();
        const expanded = el.getAttribute('aria-expanded');
        const looksTree = /chapter|section|lesson|outline|curriculum|breakout|system design/.test(hay);
        const collapsed = expanded === 'false';
        if (!isVisible(el)) continue;
        if ((collapsed || looksTree) && !/next|continue|previous|back/.test(hay)) {
          try { el.click(); clicked++; await sleep(120); } catch {}
        }
      }
      if (!clicked) break;
      await sleep(300);
    }
  });
}

async function discoverCurriculumFromLessonPage(page, coursePrefix) {
  await clickLikelyMiniMap(page).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await expandLikelyCurriculumTree(page).catch(() => {});

  const result = await page.evaluate((coursePrefixInner) => {
    const roots = [
      ...document.querySelectorAll('aside, nav, [role="dialog"], [class*="sidebar"], [class*="drawer"], [class*="curriculum"], [class*="outline"], [class*="toc"], [class*="mini"]'),
    ];
    const anchorPool = roots.length ? roots.flatMap((root) => [...root.querySelectorAll('a[href]')]) : [...document.querySelectorAll('a[href]')];
    const rows = anchorPool.map((a) => {
      const href = a.href || '';
      const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const rect = a.getBoundingClientRect();
      const st = window.getComputedStyle(a);
      const visible = rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      const ctx = a.closest('li, div, section')?.innerText?.slice(0, 250)?.replace(/\s+/g, ' ').trim() || '';
      let score = 0;
      const hay = `${text} ${ctx} ${href}`.toLowerCase();
      if (href && href.includes(coursePrefixInner)) score += 220;
      if (/lesson|chapter|interview|design|trap|breakout|ready|dos|dont|queue|database|cache|scal/i.test(hay)) score += 25;
      if (visible) score += 10;
      if (/blog|answer|pricing|login|signup/i.test(hay)) score -= 150;
      return { href, text, visible, score, ctx };
    }).filter((r) => r.href && r.score > 0).sort((a,b) => b.score - a.score);

    const unique = [];
    const seen = new Set();
    for (const row of rows) {
      const key = row.href.split('#')[0].split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
    }

    return {
      title: document.title || '',
      headings: [...document.querySelectorAll('h1,h2,h3')].map((el) => (el.innerText || '').trim()).filter(Boolean).slice(0, 20),
      candidates: unique,
    };
  }, coursePrefix);

  const orderedLessons = [];
  const seen = new Set();
  for (const row of result.candidates) {
    if (!isWithinCourse(row.href, coursePrefix)) continue;
    const normalized = normalizeLessonUrl(row.href);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    orderedLessons.push({ url: normalized, title: row.text, context: row.ctx, score: row.score });
  }

  return {
    source: 'lesson-mini-map',
    title: result.title,
    headings: result.headings,
    orderedLessons,
  };
}

function findNextLessonInCurriculum(orderedLessons, currentUrl) {
  const normalizedCurrent = normalizeLessonUrl(currentUrl);
  const urls = orderedLessons.map((item) => normalizeLessonUrl(item.url));
  const idx = urls.indexOf(normalizedCurrent);
  if (idx >= 0 && idx + 1 < orderedLessons.length) return normalizeLessonUrl(orderedLessons[idx + 1].url);
  return null;
}

module.exports = {
  discoverCurriculumFromPalApi,
  discoverCurriculumFromLessonPage,
  findNextLessonInCurriculum,
};
