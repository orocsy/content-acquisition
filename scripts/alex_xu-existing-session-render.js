#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'user';
const MAX_RETRIES = Number(process.env.ALEX_XU_CAPTURE_RETRIES || 4);
const RETRY_DELAY_MS = Number(process.env.ALEX_XU_CAPTURE_RETRY_DELAY_MS || 2500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTrailingJson(stdout) {
  const trimmed = String(stdout || '').trim();
  const match = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!match) throw new Error(`No JSON found in output: ${trimmed.slice(0, 400)}`);
  return JSON.parse(match[1]);
}

function runOpenClaw(args, { json = true } = {}) {
  const fullArgs = ['browser', '--browser-profile', BROWSER_PROFILE];
  if (json) fullArgs.push('--json');
  fullArgs.push(...args);
  const stdout = execFileSync('openclaw', fullArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return json ? parseTrailingJson(stdout) : stdout;
}

async function retry(label, fn) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      console.error(`[retry:${label}] attempt ${attempt}/${MAX_RETRIES} failed: ${String(err?.message || err)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

function normalizeUrl(url) {
  const u = new URL(url);
  u.hash = '';
  return u.toString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function findOrOpenTab(targetUrl) {
  const desired = normalizeUrl(targetUrl);
  const tabs = await retry('tabs', async () => runOpenClaw(['tabs']));
  const tab = tabs.tabs?.find((t) => normalizeUrl(t.url || '').startsWith(desired))
    || tabs.tabs?.find((t) => (t.url || '').includes('bytebytego.com'));
  if (tab) return tab.targetId;
  const opened = await retry('open', async () => runOpenClaw(['open', desired]));
  return opened.targetId;
}

async function waitForLesson(targetId, expectedUrl) {
  const desired = normalizeUrl(expectedUrl);
  const initialTabs = await retry('tabs', async () => runOpenClaw(['tabs']));
  const initialTab = initialTabs.tabs?.find((t) => t.targetId === targetId);
  if (initialTab && normalizeUrl(initialTab.url || '') === desired) return initialTab;

  await retry('navigate', async () => runOpenClaw(['navigate', desired, '--target-id', targetId]));
  for (let i = 0; i < 20; i++) {
    const tabs = await retry('tabs', async () => runOpenClaw(['tabs']));
    const tab = tabs.tabs?.find((t) => t.targetId === targetId);
    if (tab && normalizeUrl(tab.url || '') === desired) return tab;
    await sleep(500);
  }
  throw new Error(`Tab ${targetId} did not reach ${desired}`);
}

async function prepareTab(targetId) {
  try {
    await retry('resize', async () => runOpenClaw(['resize', '2600', '1600', '--target-id', targetId]));
  } catch (err) {
    console.error(`[prepare] resize skipped: ${String(err?.message || err)}`);
  }
  const fn = `() => {
    const mark = (el, prop, value) => el && el.style.setProperty(prop, value, 'important');
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const hideSelectors = [
      'header', '.ant-layout-header', '.ant-layout-sider', 'aside', '[role="complementary"]',
      '#USE_CHAT_GPT_AI_ROOT', 'use-chat-gpt-ai',
      'img[alt*="ask alex" i]', 'img[alt*="ask alex expend" i]',
      '[aria-label*="ask alex" i]', '[id*="ask-alex" i]', '[class*="ask-alex" i]', '[class*="AskAlex" i]',
      'footer', '[class*="footer"]', '[class*="partner"]', '[class*="newsletter"]', '[class*="legal"]'
    ];
    for (const sel of hideSelectors) document.querySelectorAll(sel).forEach((el) => mark(el, 'display', 'none'));
    for (const el of [...document.querySelectorAll('body *')]) {
      const text = normalize(el.innerText || el.textContent || '');
      if (text && /unlock full access|continue with google|continue with github|ask alex/i.test(text) && text.length < 240) {
        mark(el, 'display', 'none');
      }
    }
    mark(document.documentElement, 'overflow', 'visible');
    mark(document.body, 'margin', '0');
    mark(document.body, 'background', '#fff');

    const wrappers = document.querySelectorAll('.style_learn__wJdK1 .ant-layout, .style_content__Qif_T, main.ant-layout-content, #content.style_articleWrap__Xn2yv');
    wrappers.forEach((wrapper) => {
      const wide = wrapper.matches('.style_content__Qif_T, main.ant-layout-content');
      mark(wrapper, 'margin-left', wide ? 'auto' : '0');
      mark(wrapper, 'margin-right', wide ? 'auto' : '0');
      mark(wrapper, 'width', wide ? 'min(1720px, calc(100vw - 48px))' : '100%');
      mark(wrapper, 'max-width', wide ? 'min(1720px, calc(100vw - 48px))' : 'none');
      mark(wrapper, 'box-sizing', 'border-box');
    });

    const article = document.querySelector('article.style_learnContent__K5K7M') || document.querySelector('main article') || document.querySelector('article');
    if (article) {
      mark(article, 'width', 'min(1640px, calc(100vw - 48px))');
      mark(article, 'max-width', 'min(1640px, calc(100vw - 48px))');
      mark(article, 'margin-left', 'auto');
      mark(article, 'margin-right', 'auto');
      mark(article, 'padding-left', '24px');
      mark(article, 'padding-right', '24px');
      mark(article, 'box-sizing', 'border-box');
    }

    window.scrollTo(0, 0);
    return {
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      articleWidth: article ? getComputedStyle(article).width : null,
      title: (article?.querySelector('h1') || document.querySelector('h1') || document.querySelector('h2'))?.textContent?.trim() || document.title
    };
  }`;
  return retry('evaluate', async () => runOpenClaw(['evaluate', '--target-id', targetId, '--fn', fn]));
}

async function extractArticlePayload(targetId) {
  const fn = `() => {
    const article = document.querySelector('article.style_learnContent__K5K7M') || document.querySelector('main article') || document.querySelector('article');
    if (!article) return { ok: false, reason: 'no_article' };
    const lessonRoot = document.querySelector('#content-container')
      || article.closest('#content')
      || article.parentElement
      || article;
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const styles = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
      .map((el) => el.href)
      .filter((href, index, arr) => href && arr.indexOf(href) === index);
    return {
      ok: true,
      title: document.title,
      h1: normalize((article.querySelector('h1') || document.querySelector('h1') || document.querySelector('h2'))?.textContent || document.title || 'Lesson'),
      article: article.outerHTML,
      lessonRoot: lessonRoot.outerHTML,
      styles,
      base: location.origin + '/',
      url: location.href,
    };
  }`;
  const result = await retry('extract', async () => runOpenClaw(['evaluate', '--target-id', targetId, '--fn', fn]));
  const payload = result.result || result;
  if (!payload?.ok || (!payload?.article && !payload?.lessonRoot)) throw new Error(`Article extraction failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  const [, , url, outDirArg] = process.argv;
  if (!url || !outDirArg) {
    console.error('Usage: node scripts/alex_xu-existing-session-render.js <url> <outDir>');
    process.exit(1);
  }

  const outDir = path.resolve(outDirArg);
  ensureDir(outDir);

  const targetId = await findOrOpenTab(url);
  const tab = await waitForLesson(targetId, url);
  const prep = await prepareTab(targetId);
  const payload = await extractArticlePayload(targetId);

  const tmpJson = path.join(os.tmpdir(), `alex_xu-article-${Date.now()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(payload, null, 2));

  try {
    const stdout = execFileSync('node', [
      path.join(__dirname, 'alex_xu_render_article.js'),
      tmpJson,
      outDir,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const rendered = parseTrailingJson(stdout);
    console.log(JSON.stringify({
      ok: true,
      targetId,
      finalUrl: tab.url,
      prep: prep.result || prep,
      render: rendered,
    }, null, 2));
  } finally {
    fs.unlinkSync(tmpJson);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
