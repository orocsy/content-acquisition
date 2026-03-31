'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const coreUtils = require('../../../core/utils');

const AUTH_MARKER_RE = /\b(?:unlock full access|unlock\b|full access|log in|login|sign in|sign up|continue with google|continue with github)\b/i;
const STRONG_LOCK_RE = /\bunlock full access\b/i;
const LOGIN_RE = /\b(?:log in|login|sign in)\b/i;

function normalizeLessonUrl(input) {
  const url = new URL(input);
  url.hash = '';
  url.search = '';
  url.hostname = 'bytebytego.com';
  return url.toString();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getDefaultChromeProfileDir() {
  return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
}

function extractFirebaseAuthStateFromChromeProfile(profileDir = getDefaultChromeProfileDir()) {
  const indexedDbLog = path.join(profileDir, 'IndexedDB', 'https_bytebytego.com_0.indexeddb.leveldb', '000004.log');
  if (!fs.existsSync(indexedDbLog)) return null;
  const data = fs.readFileSync(indexedDbLog, 'utf8').replace(/\x00/g, ' ');
  const apiKey = /firebase:authUser:(AIza[\w-]+):\[DEFAULT\]/.exec(data)?.[1];
  const uid = /uid"\W*([A-Za-z0-9_-]{10,})"/.exec(data)?.[1];
  const email = /email"\W*([^"\s]+@[^"\s]+)"/.exec(data)?.[1];
  const displayName = /displayName"\W*([^"\r\n]+)"/.exec(data)?.[1];
  const photoURL = /photoURL"\W*([h`][^"\s]+)"?/.exec(data)?.[1]?.replace(/^`/, '');
  const providerUid = /providerId"\W*google\.com"\W*uid"\W*([0-9]{6,})"/.exec(data)?.[1];
  const refreshToken = /refreshToken"\W*([A-Za-z0-9._-]{20,})/.exec(data)?.[1];
  const accessToken = /accessToken"\W*([A-Za-z0-9._-]{100,})/.exec(data)?.[1];
  const expirationTime = /expirationTime\W*(\d{10,})/.exec(data)?.[1];
  const createdAt = /createdAt\W*(\d{10,})/.exec(data)?.[1];
  const lastLoginAt = /lastLoginAt\W*(\d{10,})/.exec(data)?.[1];
  if (!apiKey || !uid || !refreshToken || !accessToken) return null;

  return {
    apiKey,
    storageKey: `firebase:authUser:${apiKey}:[DEFAULT]`,
    value: {
      uid,
      email: email || null,
      emailVerified: true,
      displayName: displayName || null,
      isAnonymous: false,
      photoURL: photoURL || null,
      phoneNumber: null,
      tenantId: null,
      providerData: [{
        providerId: 'google.com',
        uid: providerUid || null,
        displayName: displayName || null,
        email: email || null,
        phoneNumber: null,
        photoURL: photoURL || null,
      }],
      stsTokenManager: {
        refreshToken,
        accessToken,
        expirationTime: expirationTime || String(Date.now() + 60 * 60 * 1000),
      },
      redirectEventId: null,
      createdAt: createdAt || String(Date.now()),
      lastLoginAt: lastLoginAt || String(Date.now()),
      apiKey,
      appName: '[DEFAULT]',
    },
  };
}

async function getChromeCookies(url) {
  const chromeCookies = require('chrome-cookies-secure');
  return await new Promise((resolve, reject) => {
    chromeCookies.getCookies(url, 'puppeteer', (err, cookies) => {
      if (err) return reject(err);
      resolve(cookies || []);
    });
  });
}

async function fetchHtmlWithChromeCookies(url) {
  const normalizedUrl = normalizeLessonUrl(url);
  const cookies = await getChromeCookies(normalizedUrl);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

  const response = await new Promise((resolve, reject) => {
    const req = https.get(normalizedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, html: data, cookies }));
    });
    req.on('error', reject);
  });

  return {
    ...response,
    html: String(response.html || ''),
    normalizedUrl,
  };
}

function htmlToText(html) {
  return normalizeText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function buildAuthSnapshotFromHtml(html, opts = {}) {
  const text = htmlToText(html);
  const authMarkers = [...new Set([
    ...String(text).match(/Unlock Full Access/gi) || [],
    ...String(text).match(/Continue with Google/gi) || [],
    ...String(text).match(/Continue with GitHub/gi) || [],
    ...String(text).match(/\b(?:Login|Log in|Sign in)\b/gi) || [],
  ])];
  const headings = [...String(html).matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => normalizeText(match[1].replace(/<[^>]+>/g, ' ')))
    .filter(Boolean)
    .slice(0, 16);
  const lessonLinkCount = (String(html).match(/\/courses\//g) || []).length;
  return {
    authMarkers,
    headings,
    mainText: text.slice(0, 3000),
    lessonLinkCount,
  };
}

function slugToTitle(currentUrl) {
  try {
    const parts = new URL(normalizeLessonUrl(currentUrl)).pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || 'page';
    return slug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  } catch {
    return 'Page';
  }
}

function cleanTitleCandidate(value, cleanTitle) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  return normalizeText(typeof cleanTitle === 'function' ? cleanTitle(normalized) : normalized);
}

function extractNextDataJsonFromHtml(html) {
  const match = String(html || '').match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function createMdxRuntime() {
  function jsx(type, props, key) {
    return { type, props: props || {}, key };
  }
  return { jsx, jsxs: jsx, Fragment: 'Fragment' };
}

function createMdxComponents() {
  const basic = {
    CodeTabs: (props) => ({ type: 'CodeTabs', props: props || {} }),
    Figure: (props) => ({ type: 'Figure', props: props || {} }),
    Image: (props) => ({ type: 'Image', props: props || {} }),
    Callout: (props) => ({ type: 'Callout', props: props || {} }),
    Hint: (props) => ({ type: 'Hint', props: props || {} }),
    Note: (props) => ({ type: 'Note', props: props || {} }),
    Warning: (props) => ({ type: 'Warning', props: props || {} }),
  };
  return new Proxy(basic, {
    get(target, key) {
      if (key in target) return target[key];
      return (props) => ({ type: String(key), props: props || {} });
    },
  });
}

function renderMdxNodeToText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) renderMdxNodeToText(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    return renderMdxNodeToText(node.type(node.props || {}), out);
  }

  if (node.type === 'Image' && node.props?.alt) {
    out.push(`\n[Image] ${normalizeText(node.props.alt)}\n`);
  }
  if (node.type === 'CodeTabs') out.push('\n');
  if (node.type === 'pre') out.push('\n');
  if (node.type === 'code') out.push('`');
  if (node.type === 'br') out.push('\n');
  if (node.type === 'h1' || node.type === 'h2' || node.type === 'h3' || node.type === 'h4') out.push('\n');
  if (node.type === 'p' || node.type === 'li') out.push('\n');

  if (node.props) renderMdxNodeToText(node.props.children, out);

  if (node.type === 'code') out.push('`');
  if (node.type === 'p' || node.type === 'li' || node.type === 'pre') out.push('\n');
  return out;
}

function extractLessonDocumentFromFetchedHtml(html, currentUrl, opts = {}) {
  const nextData = extractNextDataJsonFromHtml(html);
  const pageProps = nextData?.props?.pageProps || {};
  const code = pageProps.code || '';
  const frontmatterTitle = pageProps.title || pageProps?.frontmatter?.title || '';

  if (!code) {
    return {
      title: cleanTitleCandidate(frontmatterTitle, opts.cleanTitle) || slugToTitle(currentUrl),
      text: htmlToText(html),
    };
  }

  const fn = new Function('_jsx_runtime', `${code}\n return Component;`);
  const componentExports = fn(createMdxRuntime());
  const tree = componentExports.default({ components: createMdxComponents() });
  const text = normalizeText(renderMdxNodeToText(tree).join(' ').replace(/\n\s*\n\s*\n+/g, '\n\n'));

  return {
    title: cleanTitleCandidate(frontmatterTitle, opts.cleanTitle) || slugToTitle(currentUrl),
    text,
  };
}

function isGenericByteByteGoTitle(value, cleanTitle) {
  const normalized = cleanTitleCandidate(value, cleanTitle).toLowerCase();
  if (!normalized) return true;
  if (normalized === 'bytebytego') return true;
  if (normalized === 'technical interview prep') return true;
  if (normalized === 'unlock full access') return true;
  if (normalized === 'login' || normalized === 'log in' || normalized === 'sign in') return true;
  return normalized.includes('bytebytego | technical interview prep');
}

function analyzeByteByteGoAuthSnapshot(snapshot = {}, opts = {}) {
  const cleanTitle = opts.cleanTitle;
  const headings = (snapshot.headings || [])
    .map((heading) => cleanTitleCandidate(heading, cleanTitle))
    .filter(Boolean);
  const markers = [...new Set((snapshot.authMarkers || []).map((marker) => normalizeText(marker)).filter(Boolean))];
  const bodyText = normalizeText(snapshot.mainText || snapshot.bodyText || '');
  const lessonLinkCount = Number(snapshot.lessonLinkCount) || 0;
  const hasStrongLockMarker = markers.some((marker) => STRONG_LOCK_RE.test(marker)) || STRONG_LOCK_RE.test(bodyText);
  const hasLoginMarker = markers.some((marker) => LOGIN_RE.test(marker));
  const hasMeaningfulHeading = headings.some((heading) => !isGenericByteByteGoTitle(heading, cleanTitle));

  const locked = hasStrongLockMarker || (hasLoginMarker && !hasMeaningfulHeading && lessonLinkCount === 0);
  const reasons = [];
  if (hasStrongLockMarker) reasons.push('visible unlock marker');
  if (hasLoginMarker && !hasMeaningfulHeading && lessonLinkCount === 0) reasons.push('login CTA with no lesson structure');

  return {
    locked,
    reasons,
    markers: markers.slice(0, 8),
    headings: headings.slice(0, 8),
    lessonLinkCount,
  };
}

async function getByteByteGoAuthSnapshot(page, ctx = {}) {
  return await page.evaluate((coursePrefixInner, authMarkerSource) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const authMarkerRe = new RegExp(authMarkerSource, 'i');
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0';
    };
    const safeHref = (href) => {
      try {
        const resolved = new URL(href, location.href);
        resolved.hash = '';
        resolved.search = '';
        return resolved.toString();
      } catch {
        return null;
      }
    };

    const authMarkers = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], h1, h2, h3, p, span, div')]
      .filter((el) => isVisible(el))
      .map((el) => normalize(el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.value || ''))
      .filter((text, index, arr) => text && authMarkerRe.test(text) && arr.indexOf(text) === index)
      .slice(0, 24);

    const headings = [...document.querySelectorAll('main h1, article h1, h1, main h2, article h2, h2')]
      .filter((el) => isVisible(el))
      .map((el) => normalize(el.innerText || el.textContent || ''))
      .filter(Boolean)
      .slice(0, 16);

    const mainRoot = document.querySelector('main, article, [role="main"]') || document.body;
    const mainText = normalize(mainRoot?.innerText || '').slice(0, 3000);
    const currentUrl = safeHref(location.href);
    const lessonLinkCount = [...document.querySelectorAll('a[href]')]
      .map((anchor) => safeHref(anchor.getAttribute('href') || anchor.href || ''))
      .filter((href) => href && href !== currentUrl && (!coursePrefixInner || new URL(href).pathname.startsWith(coursePrefixInner)))
      .length;

    return {
      rawTitle: document.title || '',
      headings,
      authMarkers,
      mainText,
      lessonLinkCount,
    };
  }, ctx.coursePrefix || '', AUTH_MARKER_RE.source);
}

async function assertUnlockedCoursePage(page, ctx = {}) {
  const currentUrl = normalizeLessonUrl(ctx.currentUrl || page.url());
  let snapshot;

  try {
    const fetched = await fetchHtmlWithChromeCookies(currentUrl);
    snapshot = buildAuthSnapshotFromHtml(fetched.html, ctx);
    snapshot.fetchStatus = fetched.status;
    snapshot.fetchCookieCount = fetched.cookies.length;
    snapshot.mainText = snapshot.mainText || htmlToText(fetched.html).slice(0, 3000);
  } catch {
    snapshot = await getByteByteGoAuthSnapshot(page, ctx);
  }

  const analysis = analyzeByteByteGoAuthSnapshot(snapshot, ctx);
  if (!analysis.locked) return analysis;

  const markerSummary = analysis.markers.length ? analysis.markers.join(' | ') : 'no explicit markers captured';
  throw new Error(`[auth] ByteByteGo page appears locked at ${currentUrl}: ${analysis.reasons.join(', ')} (${markerSummary})`);
}

function selectByteByteGoLessonTitle(snapshot = {}, opts = {}) {
  const cleanTitle = opts.cleanTitle;
  const candidates = [
    opts.curriculumTitle,
    ...(snapshot.headings || []),
    snapshot.ogTitle,
    snapshot.twitterTitle,
    snapshot.metaTitle,
    snapshot.rawTitle,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanTitleCandidate(candidate, cleanTitle);
    if (!cleaned) continue;
    if (isGenericByteByteGoTitle(cleaned, cleanTitle)) continue;
    return cleaned;
  }

  return slugToTitle(opts.currentUrl);
}

async function extractLessonTitleFromPage(page, opts = {}) {
  const snapshot = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0';
    };
    const headings = [...document.querySelectorAll('main h1, article h1, h1, main h2, article h2, h2, h3')]
      .filter((el) => isVisible(el))
      .map((el) => normalize(el.innerText || el.textContent || ''))
      .filter(Boolean)
      .slice(0, 16);
    return {
      rawTitle: document.title || '',
      headings,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
      twitterTitle: document.querySelector('meta[name="twitter:title"]')?.content || '',
      metaTitle: document.querySelector('meta[name="title"]')?.content || '',
    };
  });

  return selectByteByteGoLessonTitle(snapshot, opts);
}

module.exports = {
  ...coreUtils,
  analyzeByteByteGoAuthSnapshot,
  assertUnlockedCoursePage,
  buildAuthSnapshotFromHtml,
  extractFirebaseAuthStateFromChromeProfile,
  extractLessonDocumentFromFetchedHtml,
  extractLessonTitleFromPage,
  fetchHtmlWithChromeCookies,
  getChromeCookies,
  htmlToText,
  isGenericByteByteGoTitle,
  normalizeLessonUrl,
  selectByteByteGoLessonTitle,
};
