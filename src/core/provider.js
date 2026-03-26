'use strict';

/**
 * core/provider.js — BaseProvider contract.
 *
 * Every content provider must extend BaseProvider and implement:
 *   - normalizeUrl(url)           → canonical string
 *   - courseSlugFromUrl(url)      → string used as output directory name
 *   - lessonSlugFromUrl(url)      → string used as lesson sub-directory suffix
 *   - isCourseLessonUrl(url, ctx) → bool: is this URL a capturable lesson?
 *   - buildCourseContext(url)     → { coursePrefix, courseSlug, ... } from a starting URL
 *
 * Browser-lifecycle hooks (all optional, async):
 *   - setupBrowser(opts)          → { browser, page } (default: launch puppeteer)
 *   - applyAuth(page, url)        → inject cookies / headers
 *   - applyStealthPatches(page)   → anti-detection tweaks
 *
 * Curriculum discovery (all optional, async):
 *   - discoverCurriculum(page, ctx) → { orderedLessons, ... }
 *
 * Lesson navigation (all optional, async):
 *   - clickNextLesson(page, ctx)  → { ok, url, reason }
 */

class BaseProvider {
  /** @param {string} name - Human-readable provider id, e.g. 'educative' */
  constructor(name) {
    this.name = name;
  }

  // ── URL helpers ──────────────────────────────────────────────────────────────

  /** Canonicalize a URL (strip hash/search, force hostname, etc.) */
  normalizeUrl(url) {
    throw new Error(`${this.name}.normalizeUrl() not implemented`);
  }

  /** Returns a slug string suitable as a filesystem directory name for the course. */
  courseSlugFromUrl(url) {
    throw new Error(`${this.name}.courseSlugFromUrl() not implemented`);
  }

  /** Returns a slug for a single lesson page. */
  lessonSlugFromUrl(url, fallback = 'page') {
    throw new Error(`${this.name}.lessonSlugFromUrl() not implemented`);
  }

  /**
   * Returns true if `url` looks like a scrapeable lesson page within the given context.
   * @param {string} url
   * @param {{ coursePrefix?: string }} [ctx]
   */
  isCourseLessonUrl(url, ctx = {}) {
    return false;
  }

  /**
   * Given the start URL, compute a context object used throughout scraping.
   * Minimum shape: { coursePrefix, courseSlug }
   * @param {string} startUrl
   * @returns {object}
   */
  buildCourseContext(startUrl) {
    throw new Error(`${this.name}.buildCourseContext() not implemented`);
  }

  // ── Browser lifecycle ────────────────────────────────────────────────────────

  /** Launch browser and create a page. Returns { browser, page }. */
  async setupBrowser(opts = {}) {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: opts.headless !== false,
      executablePath: opts.executablePath,
      defaultViewport: { width: 1440, height: 900 },
      args: ['--no-first-run', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const page = await browser.newPage();
    return { browser, page };
  }

  /** Inject auth credentials (cookies, tokens) onto a page. */
  async applyAuth(page, url) {
    // Default: no-op
  }

  /** Apply anti-bot detection patches. */
  async applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
    });
  }

  // ── Curriculum discovery ─────────────────────────────────────────────────────

  /**
   * Attempt to discover the full ordered lesson list.
   * @param {object} page - puppeteer Page
   * @param {object} ctx  - course context from buildCourseContext()
   * @returns {{ orderedLessons: Array<{url, title}>, source: string, ... }}
   */
  async discoverCurriculum(page, ctx) {
    return { orderedLessons: [], source: 'none' };
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  /**
   * Navigate to the next lesson.
   * @param {object} page
   * @param {{ visitedUrls: Set, coursePrefix: string, courseMap: object, curriculumOrderedLessons: Array }} ctx
   * @returns {{ ok: bool, url?: string, reason: string }}
   */
  async clickNextLesson(page, ctx) {
    return { ok: false, reason: 'clickNextLesson() not implemented' };
  }
}

module.exports = { BaseProvider };
