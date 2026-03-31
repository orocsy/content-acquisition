'use strict';

const { normalizeLessonUrl } = require('./utils');

function isCourseLessonUrl(url, coursePrefix, courseRootUrl) {
  if (!url) return false;
  try {
    const normalized = normalizeLessonUrl(url);
    const pathname = new URL(normalized).pathname;
    return pathname.startsWith(coursePrefix) && normalized !== normalizeLessonUrl(courseRootUrl);
  } catch {
    return false;
  }
}

function dedupeCandidates(candidates, normalizeUrl) {
  const normalize = normalizeUrl || normalizeLessonUrl;
  const seen = new Set();
  const ordered = [];

  for (const candidate of candidates || []) {
    if (!candidate?.url) continue;
    const href = normalize(candidate.url);
    if (seen.has(href)) continue;
    seen.add(href);
    ordered.push({ ...candidate, url: href });
  }

  return ordered;
}

async function discoverPageStructure(page, coursePrefix) {
  return await page.evaluate((coursePrefixInner) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href]')];
    const rows = anchors.map((anchor, domIndex) => {
      const href = anchor.href || anchor.getAttribute('href') || '';
      const text = normalize(anchor.innerText || anchor.textContent || '');
      const aria = normalize(anchor.getAttribute('aria-label') || '');
      const title = normalize(anchor.getAttribute('title') || '');
      const rect = anchor.getBoundingClientRect();
      const style = window.getComputedStyle(anchor);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      const inLikelySidebar = !!anchor.closest('nav, aside, [class*="sidebar"], [class*="toc"], [class*="curriculum"], [class*="outline"], [data-testid*="sidebar"]');
      const hay = `${text} ${aria} ${title} ${href}`.toLowerCase();
      let score = 0;
      if (href && href.includes(coursePrefixInner)) score += 180;
      if (inLikelySidebar) score += 40;
      if (visible) score += 12;
      if (/next lesson|continue|next|chapter|lesson|module|pattern|topic/i.test(hay)) score += 25;
      if (/login|sign in|unlock|pricing|affiliate|contributor|privacy|terms|mailto:/i.test(hay)) score -= 180;
      return { domIndex, href, text, aria, title, score, visible, inLikelySidebar };
    }).filter((row) => row.href && row.score > 0);

    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .map((el) => normalize(el.innerText || el.textContent || ''))
      .filter(Boolean)
      .slice(0, 12);

    const bodyText = normalize(document.body?.innerText || '').slice(0, 2000).toLowerCase();
    const pageType = /table of contents|curriculum|chapter outline|lesson/.test(bodyText) && rows.length > 2
      ? 'lesson-or-course'
      : 'page';

    return {
      url: location.href,
      title: document.title || '',
      headings,
      pageType,
      coursePrefix: coursePrefixInner,
      lessonCandidates: rows.map((row) => ({
        url: row.href,
        text: row.text || row.aria || row.title || '',
        score: row.score,
        visible: row.visible,
        inLikelySidebar: row.inLikelySidebar,
        domIndex: row.domIndex,
      })),
    };
  }, coursePrefix);
}

function pickNextLessonFromCandidates({ currentUrl, candidates, visitedUrls, coursePrefix, courseRootUrl, normalizeUrl }) {
  const normalize = normalizeUrl || normalizeLessonUrl;
  const normalizedCurrent = normalize(currentUrl);
  const ordered = dedupeCandidates(
    [...(candidates || [])].sort((a, b) => (a.domIndex || 0) - (b.domIndex || 0)),
    normalize,
  ).filter((candidate) => {
    if (!candidate.url) return false;
    if (visitedUrls.has(candidate.url)) return false;
    return isCourseLessonUrl(candidate.url, coursePrefix, courseRootUrl);
  });

  const currentIndex = ordered.findIndex((candidate) => candidate.url === normalizedCurrent);
  if (currentIndex >= 0) {
    for (let index = currentIndex + 1; index < ordered.length; index++) {
      if (!visitedUrls.has(ordered[index].url)) return ordered[index].url;
    }
  }

  const explicitNext = ordered.find((candidate) => /next lesson|continue|next/i.test(candidate.text || ''));
  if (explicitNext) return explicitNext.url;

  return ordered[0]?.url || null;
}

async function clickNextButtonOnPage(page, { beforeUrl, visitedUrls, coursePrefix, courseRootUrl, timeoutMs, normalizeUrl, isCourseLessonUrl: isLesson }) {
  const normalize = normalizeUrl || normalizeLessonUrl;
  const buttonCandidates = await page.evaluate((coursePrefixInner) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('a, button, [role="button"]')];
    return els.map((el, index) => {
      const text = normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      const href = el.href || el.getAttribute('href') || null;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
      const hay = `${text} ${href || ''}`.toLowerCase();
      let score = 0;
      if (/\bnext lesson\b/.test(hay)) score += 120;
      else if (/\bcontinue\b/.test(hay)) score += 80;
      else if (/\bnext\b/.test(hay)) score += 60;
      if (href && href.includes(coursePrefixInner)) score += 120;
      if (/\bprev|previous|back\b/.test(hay)) score -= 120;
      if (/login|sign in|unlock|pricing/.test(hay)) score -= 240;
      if (!visible || disabled) score -= 1000;
      return { index, href, score };
    }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  }, coursePrefix);

  const nextInfo = (buttonCandidates || []).find((candidate) => {
    if (!candidate) return false;
    const href = candidate.href ? normalize(candidate.href) : null;
    if (href && href === beforeUrl) return false;
    if (href && visitedUrls.has(href)) return false;
    if (href) return isLesson ? isLesson(href) : isCourseLessonUrl(href, coursePrefix, courseRootUrl);
    return true;
  });

  if (!nextInfo) return { ok: false, reason: 'No valid next button found' };

  const navPromise = page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs }).catch(() => null);
  const clicked = await page.evaluate((index) => {
    const el = [...document.querySelectorAll('a, button, [role="button"]')][index];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, nextInfo.index);
  if (!clicked) return { ok: false, reason: 'Element gone before click' };
  await navPromise;

  const afterUrl = normalize(page.url());
  if (afterUrl !== beforeUrl && (isLesson ? isLesson(afterUrl) : isCourseLessonUrl(afterUrl, coursePrefix, courseRootUrl))) {
    return { ok: true, url: afterUrl, reason: 'clicked-next' };
  }

  if (nextInfo.href) {
    const href = normalize(nextInfo.href);
    if (href !== beforeUrl &&
      !visitedUrls.has(href) &&
      (isLesson ? isLesson(href) : isCourseLessonUrl(href, coursePrefix, courseRootUrl))) {
      await page.goto(href, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs });
      return { ok: true, url: normalize(page.url()), reason: 'href-fallback' };
    }
  }

  return { ok: false, reason: 'Navigation did not reach a valid course lesson' };
}

module.exports = {
  clickNextButtonOnPage,
  discoverPageStructure,
  isCourseLessonUrl,
  pickNextLessonFromCandidates,
};
