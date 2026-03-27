'use strict';

/**
 * providers/educative/index.js — Educative.io provider.
 *
 * Implements BaseProvider for Educative.io interview-prep paths.
 * Handles:
 *   - Cookie injection from local Chrome profile
 *   - Curriculum discovery via the /api/interview-prep/collection endpoint
 *   - Fallback mini-map scraping for curriculum
 *   - Page structure discovery for the course-map graph
 *   - Next-lesson navigation (curriculum order → graph edges → page buttons)
 */

const { BaseProvider } = require('../../core/provider');
const { slugify } = require('../../core/utils');
const curriculum = require('./lib/curriculum');
const navigation = require('./lib/navigation');
const courseMapLib = require('../../core/course-map');

class EducativeProvider extends BaseProvider {
  constructor() {
    super('educative');
  }

  // ── URL helpers ──────────────────────────────────────────────────────────────

  normalizeUrl(url) {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.hostname = 'www.educative.io';
    return u.toString();
  }

  courseSlugFromUrl(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => p === 'courses' || p === 'interview-prep' || p === 'path');
      if (idx >= 0 && parts[idx + 1]) return slugify(parts[idx + 1]);
      return slugify(parts.slice(0, 2).join('-'));
    } catch {
      return 'educative-course';
    }
  }

  lessonSlugFromUrl(url, fallback = 'page') {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return slugify(parts[parts.length - 1] || fallback);
    } catch {
      return slugify(fallback);
    }
  }

  isCourseLessonUrl(url, ctx = {}) {
    if (!url) return false;
    try {
      const normalized = this.normalizeUrl(url);
      const coursePrefix = ctx.coursePrefix || '';
      return normalized.includes(coursePrefix) &&
        !/\/blog\//i.test(normalized) &&
        !/\/answers\//i.test(normalized);
    } catch {
      return false;
    }
  }

  buildCourseContext(startUrl) {
    const normalized = this.normalizeUrl(startUrl);
    const parts = new URL(normalized).pathname.split('/').filter(Boolean);
    const coursePrefix = `/${parts.slice(0, Math.max(0, parts.length - 1)).join('/')}/`;
    const courseSlug = this.courseSlugFromUrl(normalized);
    return { coursePrefix, courseSlug, startUrl: normalized };
  }

  cleanTitle(rawTitle) {
    return rawTitle.replace(/\s*[\|–-]\s*Educative.*$/i, '').trim();
  }

  // ── Browser lifecycle ────────────────────────────────────────────────────────

  async setupBrowser(opts = {}) {
    const puppeteer = require('puppeteer');
    const fs = require('fs');

    function pickExecutablePath() {
      const candidates = [
        process.env.CHROME_PATH,
        process.env.BROWSER_EXECUTABLE_PATH,
        opts.executablePath,
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }

      try {
        const bundled = puppeteer.executablePath();
        if (bundled && fs.existsSync(bundled)) return bundled;
      } catch {}

      return undefined;
    }

    const executablePath = pickExecutablePath();
    const browser = await puppeteer.launch({
      headless: opts.headless !== false,
      ...(executablePath ? { executablePath } : {}),
      defaultViewport: { width: 1440, height: 900 },
      args: ['--no-first-run', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const page = await browser.newPage();
    return { browser, page };
  }

  async applyAuth(page, url) {
    const chromeCookies = require('chrome-cookies-secure');
    await new Promise((resolve) => {
      chromeCookies.getCookies(url, 'puppeteer', async (err, cookies) => {
        if (err) {
          console.error(`[cookies] Failed to extract: ${err.message}`);
        } else if (cookies.length > 0) {
          await page.setCookie(...cookies);
          console.error(`[auth] Injected ${cookies.length} cookies`);
        }
        resolve();
      });
    });
  }

  async applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
      const fakePlugins = ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client'].map((name) => ({
        name, filename: name.toLowerCase().replace(/\s/g, '_') + '.so', description: '',
      }));
      Object.defineProperty(navigator, 'plugins', {
        get: () => Object.assign(fakePlugins, {
          item: (i) => fakePlugins[i],
          namedItem: (n) => fakePlugins.find((p) => p.name === n),
          refresh: () => {},
        }),
        configurable: true,
      });
    });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  }

  // ── Curriculum discovery ─────────────────────────────────────────────────────

  async discoverCurriculum(page, ctx) {
    const { coursePrefix } = ctx;
    try {
      const result = await curriculum.discoverCurriculumFromPalApi(page, coursePrefix);
      return result;
    } catch (err) {
      console.error(`[curriculum] API discovery failed: ${String(err)}`);
      const result = await curriculum.discoverCurriculumFromLessonPage(page, coursePrefix);
      return result;
    }
  }

  // ── Page structure discovery ──────────────────────────────────────────────────

  async discoverPageStructure(page, ctx) {
    return navigation.discoverPageStructure(page, ctx.coursePrefix);
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  async clickNextLesson(page, ctx) {
    const { visitedUrls, coursePrefix, courseMap, curriculumOrderedLessons, timeoutMs } = ctx;
    const beforeUrl = this.normalizeUrl(page.url());

    const discovered = await navigation.discoverPageStructure(page, coursePrefix);
    courseMapLib.mergePageDiscovery(courseMap, discovered, (u) => this.normalizeUrl(u));

    // 1. Curriculum order
    let nextHref = curriculum.findNextLessonInCurriculum(curriculumOrderedLessons || [], beforeUrl);
    if (nextHref && visitedUrls.has(nextHref)) nextHref = null;

    // 2. Course-map graph
    if (!nextHref) {
      nextHref = courseMapLib.findNextFromMap(courseMap, beforeUrl, visitedUrls, (u) => this.normalizeUrl(u));
    }

    // 3. Page-discovered candidates
    if (!nextHref) {
      nextHref = navigation.pickNextLessonFromCandidates({
        currentUrl: beforeUrl,
        candidates: discovered.lessonCandidates,
        visitedUrls,
        coursePrefix,
        normalizeUrl: (u) => this.normalizeUrl(u),
      });
    }

    if (nextHref) {
      await page.goto(nextHref, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs });
      const afterUrl = this.normalizeUrl(page.url());
      if (afterUrl !== beforeUrl && this.isCourseLessonUrl(afterUrl, { coursePrefix })) {
        return { ok: true, url: afterUrl, reason: 'direct-course-link' };
      }
    }

    // 4. Click "Next" button on page
    return navigation.clickNextButtonOnPage(page, {
      beforeUrl,
      visitedUrls,
      coursePrefix,
      timeoutMs,
      normalizeUrl: (u) => this.normalizeUrl(u),
      isCourseLessonUrl: (u) => this.isCourseLessonUrl(u, { coursePrefix }),
    });
  }
}

module.exports = new EducativeProvider();
