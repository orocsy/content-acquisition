'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { BaseProvider } = require('../../core/provider');
const { slugify } = require('../../core/utils');
const curriculum = require('./lib/curriculum');
const navigation = require('./lib/navigation');
const utils = require('./lib/utils');
const courseMapLib = require('../../core/course-map');

const ROOT_SEGMENTS = new Set(['course', 'courses', 'guide', 'guides', 'academy']);

class ByteByteGoProvider extends BaseProvider {
  constructor() {
    super('alex_xu');
    this.aliases = ['bytebytego'];
  }

  normalizeUrl(url) {
    const normalized = new URL(url);
    normalized.hash = '';
    normalized.search = '';
    normalized.hostname = 'bytebytego.com';
    return normalized.toString();
  }

  courseSlugFromUrl(url) {
    try {
      const parts = new URL(this.normalizeUrl(url)).pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ROOT_SEGMENTS.has(parts[0].toLowerCase())) return slugify(parts[1]);
      if (parts.length >= 2) return slugify(parts[parts.length - 2]);
      return slugify(parts[0] || 'bytebytego-course');
    } catch {
      return 'bytebytego-course';
    }
  }

  lessonSlugFromUrl(url, fallback = 'page') {
    try {
      const parts = new URL(this.normalizeUrl(url)).pathname.split('/').filter(Boolean);
      return slugify(parts[parts.length - 1] || fallback);
    } catch {
      return slugify(fallback);
    }
  }

  isCourseLessonUrl(url, ctx = {}) {
    if (!url) return false;
    try {
      const normalized = this.normalizeUrl(url);
      const pathname = new URL(normalized).pathname;
      if (!pathname.startsWith(ctx.coursePrefix || '/')) return false;
      if (ctx.courseRootUrl && normalized === this.normalizeUrl(ctx.courseRootUrl)) return false;
      return !/\/(login|signup|pricing)(\/|$)/i.test(pathname);
    } catch {
      return false;
    }
  }

  buildCourseContext(startUrl) {
    const normalized = this.normalizeUrl(startUrl);
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split('/').filter(Boolean);
    let prefixParts = parts;

    if (parts.length >= 2 && ROOT_SEGMENTS.has(parts[0].toLowerCase())) {
      prefixParts = parts.slice(0, 2);
    } else if (parts.length >= 2) {
      prefixParts = parts.slice(0, Math.max(1, parts.length - 1));
    }

    if (prefixParts.length === 0) prefixParts = ['bytebytego'];
    const lessonPrefixParts = parts.length > prefixParts.length
      ? parts.slice(0, parts.length - 1)
      : prefixParts;
    const coursePrefix = `/${prefixParts.join('/')}/`;
    const lessonPrefix = `/${lessonPrefixParts.join('/')}/`;
    const courseSlug = this.courseSlugFromUrl(normalized);
    const courseRootUrl = `${parsed.origin}${coursePrefix.slice(0, -1)}`;
    return { coursePrefix, lessonPrefix, courseSlug, courseRootUrl, origin: parsed.origin, startUrl: normalized };
  }

  defaultOutputRoot() {
    return path.join(process.env.HOME || os.homedir(), 'Documents/alex_xu');
  }

  cleanTitle(rawTitle) {
    return rawTitle.replace(/\s*[\|–-]\s*ByteByteGo.*$/i, '').trim();
  }

  async setupBrowser(opts = {}) {
    const puppeteer = require('puppeteer');
    const fs = require('fs');

    if (opts.browserWsEndpoint) {
      const browser = await puppeteer.connect({ browserWSEndpoint: opts.browserWsEndpoint });
      const pages = await browser.pages();
      const page = pages.find((candidate) => /^https?:\/\/bytebytego\.com\//i.test(candidate.url() || ''))
        || pages.find((candidate) => /^https?:/i.test(candidate.url() || ''))
        || await browser.newPage();
      return { browser, page, ownsBrowser: false };
    }

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
    return { browser, page, ownsBrowser: true };
  }

  async applyAuth(page, url) {
    const chromeCookies = require('chrome-cookies-secure');
    const firebaseAuth = utils.extractFirebaseAuthStateFromChromeProfile();
    await new Promise((resolve) => {
      chromeCookies.getCookies(url, 'puppeteer', async (err, cookies) => {
        if (err) {
          console.error(`[cookies] Failed to extract: ${err.message}`);
        } else if (cookies.length > 0) {
          await page.setCookie(...cookies);
          console.error(`[auth] Injected ${cookies.length} cookies${firebaseAuth ? ' + firebase auth state' : ''}`);
        }
        resolve();
      });
    });

    if (firebaseAuth) {
      try {
        await page.goto('https://bytebytego.com/', { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 60000 });
        await page.evaluate(async (auth) => {
          localStorage.setItem(auth.storageKey, JSON.stringify(auth.value));
          await new Promise((resolve) => {
            const req = indexedDB.open('firebaseLocalStorageDb', 1);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
                db.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
              }
            };
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction('firebaseLocalStorage', 'readwrite');
              tx.objectStore('firebaseLocalStorage').put({ fbase_key: auth.storageKey, value: auth.value, type: 'local' });
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
            };
            req.onerror = () => resolve();
          });
        }, firebaseAuth);
      } catch {}
    }
  }

  async applyStealthPatches(page) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
      if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
      const fakePlugins = ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client'].map((name) => ({
        name, filename: `${name.toLowerCase().replace(/\s/g, '_')}.so`, description: '',
      }));
      Object.defineProperty(navigator, 'plugins', {
        get: () => Object.assign(fakePlugins, {
          item: (i) => fakePlugins[i],
          namedItem: (n) => fakePlugins.find((plugin) => plugin.name === n),
          refresh: () => {},
        }),
        configurable: true,
      });
    });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
  }

  async discoverCurriculum(page, ctx) {
    const html = await page.content();

    try {
      const nextData = curriculum.extractNextDataJson(html);
      if (nextData) {
        const result = curriculum.discoverCurriculumFromNextData(nextData, ctx);
        if (result.orderedLessons.length > 0) return result;
      }
    } catch (err) {
      console.error(`[curriculum] __NEXT_DATA__ parsing failed: ${String(err)}`);
    }

    return curriculum.discoverCurriculumFromHtml(page, ctx);
  }

  async assertPageAccess(page, ctx = {}) {
    const currentUrl = this.normalizeUrl(ctx.currentUrl || page.url());
    const effectiveCtx = ctx.coursePrefix
      ? ctx
      : { ...ctx, ...this.buildCourseContext(currentUrl), currentUrl };
    return utils.assertUnlockedCoursePage(page, {
      ...effectiveCtx,
      cleanTitle: (value) => this.cleanTitle(value),
    });
  }

  async extractLessonTitle(page, ctx = {}) {
    const currentUrl = this.normalizeUrl(ctx.currentUrl || page.url());
    const curriculumTitle = (ctx.curriculumOrderedLessons || [])
      .find((lesson) => this.normalizeUrl(lesson.url) === currentUrl)?.title;

    if (curriculumTitle) return curriculumTitle;

    return utils.extractLessonTitleFromPage(page, {
      cleanTitle: (value) => this.cleanTitle(value),
      currentUrl,
      curriculumTitle,
    });
  }

  async capturePdf(page, outputPath, ctx = {}) {
    try {
      const rendered = await this.captureRenderedArticle(page, outputPath);
      if (rendered?.ok) return rendered;
      console.error('[capture] rendered article path returned non-ok result, falling back');
    } catch (err) {
      console.error(`[capture] rendered article path failed: ${String(err && err.message || err)}`);
    }
    return this.capturePageScreenshotFallback(page, outputPath, ctx);
  }

  async captureRenderedArticle(page, outputPath) {
    const { chromium } = require('playwright');

    const payload = await page.evaluate(() => {
      const article = document.querySelector('article.style_learnContent__K5K7M') || document.querySelector('main article') || document.querySelector('article');
      if (!article) return null;
      const lessonRoot = document.querySelector('#content-container')
        || article.closest('#content')
        || article.parentElement
        || article;
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const title = normalize((article.querySelector('h1') || document.querySelector('h1') || document.querySelector('h2'))?.textContent || document.title || 'Lesson');
      const styles = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
        .map((el) => el.href)
        .filter((href, index, arr) => href && arr.indexOf(href) === index);
      return {
        title,
        h1: title,
        article: article.outerHTML,
        lessonRoot: lessonRoot.outerHTML,
        styles,
      };
    });

    if (!payload?.article && !payload?.lessonRoot) throw new Error('No lesson HTML found on live page');

    const absolutizeHtml = (html) => String(html || '')
      .replace(/(src|href)="\/(?!\/)/g, (_, attr) => `${attr}="https://bytebytego.com/`)
      .replace(/url\(\/(?!\/)/g, 'url(https://bytebytego.com/');

    const escapeHtml = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const title = payload.h1 || payload.title || 'Lesson';
    const lessonRootHtml = absolutizeHtml(payload.lessonRoot || payload.article);
    const styles = Array.isArray(payload.styles) ? payload.styles : [];
    const jpgPath = outputPath.replace(/\.pdf$/i, '.jpg');

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="https://bytebytego.com/" />
  <title>${escapeHtml(title)}</title>
  ${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
    .page { width: 1640px; max-width: 1640px; margin: 0 auto; padding: 28px 24px 40px; box-sizing: border-box; }
    .meta { font-size: 20px; color: #6b7280; font-weight: 600; margin-bottom: 10px; }
    .hero { font-size: 54px; line-height: 1.04; font-weight: 800; color: #111827; letter-spacing: -0.02em; margin-bottom: 24px; }
    #capture-root, article { width: 100% !important; max-width: none !important; margin: 0 !important; }
    img, svg, canvas { max-width: 100% !important; height: auto !important; }
    pre { white-space: pre-wrap !important; overflow: visible !important; }
    code { white-space: pre-wrap !important; }
    table { max-width: 100% !important; width: 100% !important; table-layout: auto !important; }
    [style*="position: fixed"], [style*="position:sticky"], header, footer, aside, nav, .ant-layout-sider, .ant-layout-header { display: none !important; }
  </style>
</head>
<body>
  <div class="page">
    <div class="meta">alex_xu</div>
    <div class="hero">${escapeHtml(title)}</div>
    <div id="capture-root">${lessonRootHtml}</div>
  </div>
</body>
</html>`;

    const browser = await chromium.launch({ headless: true });
    try {
      const renderPage = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
      await renderPage.setContent(html, { waitUntil: 'load' });
      await renderPage.locator('#capture-root').waitFor();
      await renderPage.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : null).catch(() => {});
      await renderPage.waitForTimeout(1500);
      const target = renderPage.locator('.page').first();
      await target.screenshot({ path: jpgPath, type: 'jpeg', quality: 95 });
      await renderPage.pdf({
        path: outputPath,
        printBackground: true,
        width: '1800px',
        margin: { top: '16px', right: '16px', bottom: '16px', left: '16px' },
      });
    } finally {
      await browser.close();
    }

    let pdfBytes = 0;
    let jpgBytes = 0;
    try { pdfBytes = fs.statSync(outputPath).size; } catch {}
    try { jpgBytes = fs.statSync(jpgPath).size; } catch {}
    return { ok: pdfBytes > 20 * 1024 && jpgBytes > 20 * 1024, path: outputPath, bytes: pdfBytes, jpgPath, jpgBytes, mode: 'rendered-article' };
  }

  async capturePageScreenshotFallback(page, outputPath, ctx = {}) {
    const { execFileSync } = require('child_process');

    const currentViewport = page.viewport() || { width: 1536, height: 1400, deviceScaleFactor: 1 };
    await page.setViewport({
      width: Math.max(currentViewport.width || 1536, 1365),
      height: Math.max(currentViewport.height || 1400, 1100),
      isMobile: false,
      deviceScaleFactor: currentViewport.deviceScaleFactor || 1,
    });
    await page.emulateMediaType('screen');

    const styleHandle = await page.addStyleTag({ content: `
      header, .ant-layout-header,
      .ant-layout-sider, aside, [role="complementary"], nav[role="navigation"],
      footer, [class*="footer"], [class*="partner"], [class*="legal"], [class*="newsletter"],
      #USE_CHAT_GPT_AI_ROOT, use-chat-gpt-ai,
      [class*="chat"], [class*="Chat"], [class*="assistant"], [class*="Assistant"],
      [class*="intercom"], [class*="Intercom"], [class*="ask-alex"], [class*="AskAlex"],
      img[alt*="ask alex" i], img[alt*="ask alex expend" i],
      [aria-label*="ask alex" i], [id*="ask-alex" i] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      html, body {
        overflow: visible !important;
        overflow-x: hidden !important;
        background: #fff !important;
      }
      body {
        min-width: 0 !important;
        margin: 0 !important;
      }
      .ant-layout, .ant-layout-content, main, [role="main"], article, #content {
        background: white !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
      }
      .ant-layout {
        display: block !important;
      }
      .style_learn__wJdK1 .ant-layout {
        margin-left: 0 !important;
        width: 100% !important;
        max-width: none !important;
      }
      .style_content__Qif_T, main.ant-layout-content {
        margin-left: auto !important;
        margin-right: auto !important;
        width: min(1720px, calc(100vw - 48px)) !important;
        max-width: min(1720px, calc(100vw - 48px)) !important;
        padding-left: 24px !important;
        padding-right: 24px !important;
      }
      #content.style_articleWrap__Xn2yv {
        width: 100% !important;
        max-width: none !important;
      }
      article.style_learnContent__K5K7M {
        width: min(1640px, calc(100vw - 48px)) !important;
        max-width: min(1640px, calc(100vw - 48px)) !important;
        margin-left: auto !important;
        margin-right: auto !important;
        padding-left: 24px !important;
        padding-right: 24px !important;
      }
      pre, code, table {
        max-width: 100% !important;
        overflow-wrap: anywhere !important;
      }
    ` });

    await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const hideText = /unlock full access|continue with google|continue with github|ask alex/i;
      const mark = (el, prop, value) => el.style.setProperty(prop, value, 'important');

      for (const el of [...document.querySelectorAll('body *')]) {
        const text = normalize(el.innerText || el.textContent || '');
        if (!text) continue;
        if (hideText.test(text) && text.length < 240) {
          mark(el, 'display', 'none');
        }
      }

      for (const el of [...document.querySelectorAll('img[alt*="ask alex" i], img[alt*="ask alex expend" i], #USE_CHAT_GPT_AI_ROOT, use-chat-gpt-ai')]) {
        mark(el, 'display', 'none');
      }

      const title = [...document.querySelectorAll('h1,h2')].find((el) => normalize(el.textContent).length > 0);
      if (title) mark(title, 'margin-top', '0');

      mark(document.documentElement, '--ant-layout-sider-width', '0px');
      mark(document.body, 'margin', '0');

      const content = document.querySelector('article.style_learnContent__K5K7M');
      if (content) {
        mark(content, 'width', 'min(1640px, calc(100vw - 48px))');
        mark(content, 'max-width', 'min(1640px, calc(100vw - 48px))');
        mark(content, 'margin-left', 'auto');
        mark(content, 'margin-right', 'auto');
        mark(content, 'padding-left', '24px');
        mark(content, 'padding-right', '24px');
      }

      const wrappers = [...document.querySelectorAll('.style_learn__wJdK1 .ant-layout, .style_content__Qif_T, main.ant-layout-content, #content.style_articleWrap__Xn2yv')];
      for (const wrapper of wrappers) {
        mark(wrapper, 'margin-left', wrapper.matches('.style_content__Qif_T, main.ant-layout-content') ? 'auto' : '0');
        mark(wrapper, 'margin-right', wrapper.matches('.style_content__Qif_T, main.ant-layout-content') ? 'auto' : '0');
        mark(wrapper, 'width', wrapper.matches('.style_content__Qif_T, main.ant-layout-content') ? 'min(1720px, calc(100vw - 48px))' : '100%');
        mark(wrapper, 'max-width', wrapper.matches('.style_content__Qif_T, main.ant-layout-content') ? 'min(1720px, calc(100vw - 48px))' : 'none');
        mark(wrapper, 'box-sizing', 'border-box');
      }
    });

    const pngPath = `${outputPath}.png`;
    try {
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const maxH = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.offsetHeight
        );
        let y = 0;
        while (y < maxH) {
          window.scrollTo(0, y);
          await sleep(250);
          y += Math.max(500, Math.floor(window.innerHeight * 0.7));
        }
        window.scrollTo(0, maxH);
        await sleep(1200);
        window.scrollTo(0, 0);
        await sleep(800);
      });

      await page.waitForFunction(() => {
        const imgs = [...document.images];
        const imgsReady = imgs.every((img) => img.complete && img.naturalWidth > 0);
        const lazyReady = [...document.querySelectorAll('[loading="lazy"]')].every((el) => {
          if (el.tagName === 'IMG') return el.complete && el.naturalWidth > 0;
          return true;
        });
        return imgsReady && lazyReady;
      }, { timeout: Math.min(ctx.timeoutMs || 60000, 15000) }).catch(() => {});

      await page.waitForFunction(() => {
        const svgCount = document.querySelectorAll('svg').length;
        const canvasCount = document.querySelectorAll('canvas').length;
        return svgCount + canvasCount >= 0;
      }, { timeout: 3000 }).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 1500));
      await page.screenshot({ path: pngPath, fullPage: true, type: 'png' });
      const py = String.raw`
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.pagesizes import A4
import os, sys, tempfile

png_path, pdf_path = sys.argv[1], sys.argv[2]
img = Image.open(png_path).convert('RGB')
page_w, page_h = A4
margin = 18
usable_w = int(page_w - margin * 2)
usable_h = int(page_h - margin * 2)
scale = usable_w / img.width
slice_h = max(1, int(usable_h / scale))

c = canvas.Canvas(pdf_path, pagesize=A4)
y = 0
while y < img.height:
    chunk = img.crop((0, y, img.width, min(img.height, y + slice_h)))
    tmp = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
    tmp_path = tmp.name
    tmp.close()
    chunk.save(tmp_path, format='JPEG', quality=92)
    draw_h = chunk.height * scale
    c.drawImage(ImageReader(tmp_path), margin, page_h - margin - draw_h, width=usable_w, height=draw_h)
    c.showPage()
    os.unlink(tmp_path)
    y += slice_h
c.save()
print(os.path.getsize(pdf_path))
`;
      execFileSync('python3', ['-c', py, pngPath, outputPath], { stdio: 'pipe' });
      let bytes = 0;
      try { bytes = fs.statSync(outputPath).size; } catch {}
      return { ok: bytes > 20 * 1024, path: outputPath, bytes, mode: 'fallback-screenshot' };
    } finally {
      await styleHandle.evaluate((node) => node.remove()).catch(() => {});
      if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
      await page.reload({ waitUntil: ['domcontentloaded', 'networkidle2'], timeout: ctx.timeoutMs || 60000 }).catch(() => {});
    }
  }

  async discoverPageStructure(page, ctx) {
    return navigation.discoverPageStructure(page, ctx.coursePrefix);
  }

  async clickNextLesson(page, ctx) {
    const { visitedUrls, coursePrefix, courseRootUrl, courseMap, curriculumOrderedLessons, timeoutMs } = ctx;
    const beforeUrl = this.normalizeUrl(page.url());

    const discovered = await navigation.discoverPageStructure(page, coursePrefix);
    courseMapLib.mergePageDiscovery(courseMap, discovered, (url) => this.normalizeUrl(url));

    let nextHref = curriculum.findNextLessonInCurriculum(curriculumOrderedLessons || [], beforeUrl, visitedUrls);

    if (!nextHref) {
      nextHref = navigation.pickNextLessonFromCandidates({
        currentUrl: beforeUrl,
        candidates: discovered.lessonCandidates,
        visitedUrls,
        coursePrefix,
        courseRootUrl,
        normalizeUrl: (url) => this.normalizeUrl(url),
      });
    }

    if (!nextHref) {
      nextHref = courseMapLib.findNextFromMap(courseMap, beforeUrl, visitedUrls, (url) => this.normalizeUrl(url));
    }

    if (nextHref) {
      await page.goto(nextHref, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: timeoutMs });
      const afterUrl = this.normalizeUrl(page.url());
      if (afterUrl !== beforeUrl && this.isCourseLessonUrl(afterUrl, { coursePrefix, courseRootUrl })) {
        return { ok: true, url: afterUrl, reason: 'curriculum-url' };
      }
    }

    return navigation.clickNextButtonOnPage(page, {
      beforeUrl,
      visitedUrls,
      coursePrefix,
      courseRootUrl,
      timeoutMs,
      normalizeUrl: (url) => this.normalizeUrl(url),
      isCourseLessonUrl: (url) => this.isCourseLessonUrl(url, { coursePrefix, courseRootUrl }),
    });
  }
}

module.exports = new ByteByteGoProvider();
