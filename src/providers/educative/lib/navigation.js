'use strict';

/**
 * providers/educative/lib/navigation.js
 *
 * Educative-specific page structure discovery and next-button clicking.
 */

const { normalizeLessonUrl } = require('./utils');

function isCourseLessonUrl(url, coursePrefix) {
  if (!url) return false;
  try {
    const normalized = normalizeLessonUrl(url);
    return normalized.includes(coursePrefix) && !/\/blog\//i.test(normalized) && !/\/answers\//i.test(normalized);
  } catch {
    return false;
  }
}

async function discoverPageStructure(page, coursePrefix) {
  return await page.evaluate((coursePrefixInner) => {
    const currentUrl = location.href;
    const currentTitle = document.title || '';
    const anchors = [...document.querySelectorAll('a[href]')];
    const rows = anchors.map((a, idx) => {
      const href = a.href || a.getAttribute('href') || '';
      const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (a.getAttribute('aria-label') || '').trim();
      const title = (a.getAttribute('title') || '').trim();
      const rect = a.getBoundingClientRect();
      const st = window.getComputedStyle(a);
      const visible = rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      let score = 0;
      const hay = `${text} ${aria} ${title} ${href}`.toLowerCase();
      if (href && href.includes(coursePrefixInner)) score += 150;
      if (/lesson|chapter|interview|design|scal|api|cache|database|load balanc|queue|shard|consisten/i.test(hay)) score += 12;
      if (/next lesson|continue|next/i.test(hay)) score += 30;
      if (!visible) score -= 40;
      if (/blog|answer|pricing|signup|login/i.test(hay)) score -= 120;
      const inLikelySidebar = !!a.closest('nav, aside, [class*="sidebar"], [class*="toc"], [class*="curriculum"], [class*="lesson-list"]');
      if (inLikelySidebar) score += 20;
      return { idx, href, text, aria, title, score, inLikelySidebar, visible };
    }).filter((r) => r.href && r.score > 0).sort((a, b) => b.score - a.score);

    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 12);

    const pageType = (() => {
      const bodyText = document.body?.innerText?.slice(0, 2000)?.toLowerCase() || '';
      if (/table of contents|curriculum|lesson/.test(bodyText) && rows.length > 5) return 'lesson-or-course';
      return 'page';
    })();

    return {
      url: currentUrl,
      title: currentTitle,
      headings,
      pageType,
      coursePrefix: coursePrefixInner,
      lessonCandidates: rows.map((r) => ({
        url: r.href,
        text: r.text || r.aria || r.title || '',
        score: r.score,
        visible: r.visible,
        inLikelySidebar: r.inLikelySidebar,
      })),
    };
  }, coursePrefix);
}

function pickNextLessonFromCandidates({ currentUrl, candidates, visitedUrls, coursePrefix, normalizeUrl }) {
  const normalize = normalizeUrl || normalizeLessonUrl;
  const normalizedCurrent = normalize(currentUrl);
  for (const c of candidates || []) {
    if (!c.url) continue;
    const href = normalize(c.url);
    if (href === normalizedCurrent) continue;
    if (visitedUrls.has(href)) continue;
    if (!isCourseLessonUrl(href, coursePrefix)) continue;
    return href;
  }
  return null;
}

/**
 * Attempt to click a "Next" button on the current page as a last resort.
 */
async function clickNextButtonOnPage(page, { beforeUrl, visitedUrls, coursePrefix, timeoutMs, normalizeUrl, isCourseLessonUrl: isLesson }) {
  const normalize = normalizeUrl || normalizeLessonUrl;
  const buttonCandidates = await page.evaluate((coursePrefixInner) => {
    const els = [...document.querySelectorAll('a, button, [role="button"]')];
    return els.map((el, i) => {
      const text = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const href = el.href || el.getAttribute('href') || null;
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      const hay = `${text} ${href || ''}`.toLowerCase();
      let score = 0;
      if (/\bnext lesson\b/.test(hay)) score += 100;
      else if (/\bnext\b/.test(hay)) score += 60;
      else if (/\bcontinue\b/.test(hay)) score += 40;
      if (/\bprevious|prev|back\b/.test(hay)) score -= 80;
      if (/helpful|assessment|quiz|feedback|mark.?complete|rate this/.test(hay)) score -= 50;
      if (rect.top > window.innerHeight * 0.4) score += 8;
      if (href && coursePrefixInner && href.includes(coursePrefixInner)) score += 120;
      if (href && /\/blog\//.test(href)) score -= 200;
      if (href && /\/answers\//.test(href)) score -= 80;
      if (!visible || disabled) score -= 1000;
      return { i, href, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  }, coursePrefix);

  const nextInfo = (buttonCandidates || []).find((candidate) => {
    if (!candidate || !candidate.href) return false;
    const normalizedHref = normalize(candidate.href);
    if (normalizedHref === beforeUrl) return false;
    if (visitedUrls.has(normalizedHref)) return false;
    return isLesson ? isLesson(normalizedHref) : isCourseLessonUrl(normalizedHref, coursePrefix);
  });

  if (!nextInfo) return { ok: false, reason: 'No valid next button found' };

  const navPromise = page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs }).catch(() => null);
  const clicked = await page.evaluate((idx) => {
    const el = [...document.querySelectorAll('a, button, [role="button"]')][idx];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, nextInfo.i);
  if (!clicked) return { ok: false, reason: 'Element gone before click' };
  await navPromise;

  const afterUrl = normalize(page.url());
  if (afterUrl === beforeUrl || !(isLesson ? isLesson(afterUrl) : isCourseLessonUrl(afterUrl, coursePrefix))) {
    if (nextInfo.href) {
      const href = normalize(nextInfo.href);
      if (href !== beforeUrl && !visitedUrls.has(href) && (isLesson ? isLesson(href) : isCourseLessonUrl(href, coursePrefix))) {
        await page.goto(href, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs });
        return { ok: true, url: normalize(page.url()), reason: 'href-fallback' };
      }
    }
    return { ok: false, reason: 'Navigation did not reach a valid course lesson' };
  }
  return { ok: true, url: afterUrl, reason: 'clicked-next' };
}

module.exports = {
  isCourseLessonUrl,
  discoverPageStructure,
  pickNextLessonFromCandidates,
  clickNextButtonOnPage,
};
