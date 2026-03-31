#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'user';
const MAX_RETRIES = Number(process.env.BYTEBYTEGO_CAPTURE_RETRIES || 4);
const RETRY_DELAY_MS = Number(process.env.BYTEBYTEGO_CAPTURE_RETRY_DELAY_MS || 2500);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTrailingJson(stdout) {
  const trimmed = String(stdout || '').trim();
  const match = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!match) throw new Error(`No JSON found in output: ${trimmed.slice(0, 300)}`);
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
      const msg = String(err && err.message || err);
      console.error(`[retry:${label}] attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
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

function latestMediaPath(before) {
  const root = path.join(process.env.HOME, '.openclaw', 'media', 'browser');
  const files = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => fs.statSync(p).isFile())
    .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .filter((x) => x.mtime >= before - 1000)
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('No browser media output found');
  return files[0].p;
}

async function findOrOpenTab(targetUrl) {
  const desired = normalizeUrl(targetUrl);
  const tabs = retry('tabs', async () => runOpenClaw(['tabs']));
  const tab = (await tabs).tabs?.find((t) => normalizeUrl(t.url || '').startsWith(desired))
    || (await tabs).tabs?.find((t) => (t.url || '').includes('bytebytego.com'));
  if (tab) return tab.targetId;
  const opened = await retry('open', async () => runOpenClaw(['open', desired]));
  return opened.targetId;
}

async function waitForLesson(targetId, expectedUrl) {
  const desired = normalizeUrl(expectedUrl);
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
  await retry('resize', async () => runOpenClaw(['resize', '2600', '1600', '--target-id', targetId]));
  const fn = `() => {
    const mark = (el, prop, value) => el && el.style.setProperty(prop, value, 'important');
    const hideSelectors = [
      'header', '.ant-layout-header', '.ant-layout-sider', 'aside', '[role="complementary"]',
      '#USE_CHAT_GPT_AI_ROOT', 'use-chat-gpt-ai',
      'img[alt*="ask alex" i]', 'img[alt*="ask alex expend" i]',
      '[aria-label*="ask alex" i]', '[id*="ask-alex" i]', '[class*="ask-alex" i]', '[class*="AskAlex" i]',
      'footer', '[class*="footer"]', '[class*="partner"]', '[class*="newsletter"]', '[class*="legal"]'
    ];
    for (const sel of hideSelectors) document.querySelectorAll(sel).forEach((el) => mark(el, 'display', 'none'));
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
    const article = document.querySelector('article.style_learnContent__K5K7M');
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
      title: (document.querySelector('h1') || document.querySelector('h2'))?.textContent?.trim() || document.title
    };
  }`;
  return retry('evaluate', async () => runOpenClaw(['evaluate', '--target-id', targetId, '--fn', fn]));
}

async function snapshotRef(targetId) {
  const snap = await retry('snapshot', async () => runOpenClaw(['snapshot', '--target-id', targetId, '--format', 'aria', '--limit', '250']));
  const refs = snap.nodes || [];
  const main = refs.find((node) => node.role === 'main' && node.depth >= 1);
  if (!main) throw new Error('No main ref found in snapshot');
  return main.ref;
}

async function capture(targetId, outDir) {
  ensureDir(outDir);
  const ref = await snapshotRef(targetId);
  const before = Date.now();
  await retry('screenshot', async () => runOpenClaw(['screenshot', targetId, '--ref', ref, '--type', 'png']));
  const mediaPath = latestMediaPath(before);
  const jpgPath = path.join(outDir, 'page.jpg');
  fs.copyFileSync(mediaPath, jpgPath);

  const pdfPath = path.join(outDir, 'page.pdf');
  const py = String.raw`
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
import os, sys, tempfile

img_path, pdf_path = sys.argv[1], sys.argv[2]
img = Image.open(img_path).convert('RGB')
page_w, page_h = A4
margin = 18
usable_w = page_w - 2 * margin
usable_h = page_h - 2 * margin
scale = usable_w / img.width
slice_h = max(1, int(usable_h / scale))
c = canvas.Canvas(pdf_path, pagesize=A4)
y = 0
while y < img.height:
    chunk = img.crop((0, y, img.width, min(img.height, y + slice_h)))
    tmp = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
    tmp.close()
    chunk.save(tmp.name, format='JPEG', quality=95)
    draw_h = chunk.height * scale
    c.drawImage(ImageReader(tmp.name), margin, page_h - margin - draw_h, width=usable_w, height=draw_h)
    c.showPage()
    os.unlink(tmp.name)
    y += slice_h
c.save()
`;
  execFileSync('python3', ['-c', py, jpgPath, pdfPath], { stdio: 'pipe' });
  return { jpgPath, pdfPath, ref, mediaPath };
}

async function main() {
  const [, , url, outDirArg] = process.argv;
  if (!url || !outDirArg) {
    console.error('Usage: node scripts/bytebytego-existing-session-capture.js <url> <outDir>');
    process.exit(1);
  }
  const outDir = path.resolve(outDirArg);
  const targetId = await findOrOpenTab(url);
  const tab = await waitForLesson(targetId, url);
  const prep = await prepareTab(targetId);
  const captureResult = await capture(targetId, outDir);
  const result = { ok: true, targetId, finalUrl: tab.url, prep: prep.result || prep, ...captureResult };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
