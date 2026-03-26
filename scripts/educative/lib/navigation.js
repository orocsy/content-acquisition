'use strict';

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
    }).filter((r) => r.href && r.score > 0).sort((a,b) => b.score - a.score);

    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);

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

function pickNextLessonFromCandidates({ currentUrl, candidates, visitedUrls, coursePrefix }) {
  const normalizedCurrent = normalizeLessonUrl(currentUrl);
  for (const c of candidates || []) {
    if (!c.href) continue;
    const href = normalizeLessonUrl(c.href);
    if (href === normalizedCurrent) continue;
    if (visitedUrls.has(href)) continue;
    if (!isCourseLessonUrl(href, coursePrefix)) continue;
    return href;
  }
  return null;
}

module.exports = {
  isCourseLessonUrl,
  discoverPageStructure,
  pickNextLessonFromCandidates,
};
