#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const [, , url, outDirArg] = process.argv;
  if (!url || !outDirArg) {
    console.error('Usage: node scripts/bytebytego-playwright-capture.js <url> <outDir>');
    process.exit(1);
  }

  const outDir = path.resolve(outDirArg);
  fs.mkdirSync(outDir, { recursive: true });

  const cdpUrl = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(cdpUrl);

  let page = null;
  for (const context of browser.contexts()) {
    for (const p of context.pages()) {
      const purl = p.url();
      if (purl === url || purl.startsWith(url)) {
        page = p;
        break;
      }
    }
    if (page) break;
  }

  if (!page) {
    const context = browser.contexts()[0] || await browser.newContext();
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
  } else {
    await page.bringToFront();
    if (page.url() !== url) {
      await page.goto(url, { waitUntil: 'networkidle' });
    }
  }

  await page.setViewportSize({ width: 2200, height: 1400 });

  await page.addStyleTag({ content: `
    .ant-layout-sider,
    aside,
    [role="complementary"],
    footer,
    header.ant-layout-header,
    #USE_CHAT_GPT_AI_ROOT,
    use-chat-gpt-ai,
    img[alt*="ask alex" i],
    img[alt*="ask alex expend" i],
    [aria-label*="ask alex" i],
    [id*="ask-alex" i],
    [class*="ask-alex" i],
    [class*="AskAlex" i] {
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
      margin: 0 !important;
      min-width: 0 !important;
    }
    .style_learn__wJdK1 .ant-layout {
      margin-left: 0 !important;
      width: 100% !important;
      max-width: none !important;
      display: block !important;
    }
    .style_content__Qif_T, main.ant-layout-content {
      margin-left: auto !important;
      margin-right: auto !important;
      width: min(1720px, calc(100vw - 48px)) !important;
      max-width: min(1720px, calc(100vw - 48px)) !important;
      padding-left: 24px !important;
      padding-right: 24px !important;
      box-sizing: border-box !important;
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
      box-sizing: border-box !important;
    }
    pre, code, table {
      max-width: 100% !important;
      overflow-wrap: anywhere !important;
    }
    #openclaw-capture-header {
      width: min(1640px, calc(100vw - 48px));
      max-width: min(1640px, calc(100vw - 48px));
      margin: 24px auto 12px auto;
      padding: 0 24px;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #111827;
      background: #fff;
    }
    #openclaw-capture-header .meta {
      font-size: 20px;
      line-height: 1.35;
      color: #6b7280;
      margin-bottom: 8px;
      font-weight: 600;
    }
    #openclaw-capture-header .title {
      font-size: 52px;
      line-height: 1.05;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #111827;
    }
  `});

  await page.evaluate(() => {
    const article = document.querySelector('article.style_learnContent__K5K7M') || document.querySelector('article');
    const lessonTitle = article?.querySelector('h1')?.textContent?.trim() || document.title?.trim() || 'Lesson';
    const metaParts = Array.from(document.querySelectorAll('nav a, .ant-breadcrumb a, [class*=breadcrumb] a'))
      .map(a => a.textContent.trim())
      .filter(Boolean);
    const meta = metaParts.length ? metaParts.join(' › ') : 'ByteByteGo';

    let wrapper = document.getElementById('openclaw-capture-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'openclaw-capture-wrapper';
    }

    let header = document.getElementById('openclaw-capture-header');
    if (!header) {
      header = document.createElement('div');
      header.id = 'openclaw-capture-header';
    }

    header.innerHTML = `<div class="meta">${meta.replace(/</g, '&lt;')}</div><div class="title">${lessonTitle.replace(/</g, '&lt;')}</div>`;
    if (article && article.parentElement) {
      article.parentElement.insertBefore(wrapper, article);
      wrapper.appendChild(header);
      wrapper.appendChild(article);
    } else {
      wrapper.appendChild(header);
      document.body.prepend(wrapper);
    }
  });

  await page.waitForTimeout(1200);

  const target = page.locator('#openclaw-capture-wrapper').first();

  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const jpgPath = path.join(outDir, 'page.jpg');
  const pngPath = path.join(outDir, 'page.png');
  await target.screenshot({ path: pngPath, type: 'png' });

  // Convert PNG to JPG using macOS sips when available.
  const { execFileSync } = require('child_process');
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', pngPath, '--out', jpgPath], { stdio: 'ignore' });
    fs.unlinkSync(pngPath);
  } catch {
    fs.copyFileSync(pngPath, jpgPath);
  }

  const pdfPath = path.join(outDir, 'page.pdf');
  try {
    execFileSync('sips', ['-s', 'format', 'pdf', jpgPath, '--out', pdfPath], { stdio: 'ignore' });
  } catch (err) {
    console.error('PDF conversion failed:', err.message);
  }

  console.log(JSON.stringify({ ok: true, jpgPath, pdfPath, finalUrl: page.url() }));
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
