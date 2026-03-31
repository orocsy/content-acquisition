#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function absolutizeHtml(html, baseUrl) {
  return String(html || '')
    .replace(/(src|href)="\/(?!\/)/g, (_, attr) => `${attr}="https://bytebytego.com/`)
    .replace(/url\(\/(?!\/)/g, 'url(https://bytebytego.com/');
}

async function main() {
  const [, , inputJsonPath, outDirArg] = process.argv;
  if (!inputJsonPath || !outDirArg) {
    console.error('Usage: node scripts/alex_xu_render_article.js <input-json> <out-dir>');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(inputJsonPath), 'utf8');
  const payload = JSON.parse(raw);
  const result = payload.result || payload;
  const title = result.h1 || result.title || 'Lesson';
  const styles = Array.isArray(result.styles) ? result.styles : [];
  const lessonRootHtml = absolutizeHtml(result.lessonRoot || result.article || '', result.base || 'https://bytebytego.com/');
  if (!lessonRootHtml) throw new Error('No article HTML found');

  const outDir = path.resolve(outDirArg);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'render.html');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="https://bytebytego.com/" />
  <title>${String(title).replace(/</g, '&lt;')}</title>
  ${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; }
    .page { width: 1640px; max-width: 1640px; margin: 0 auto; padding: 28px 24px 40px; box-sizing: border-box; }
    .meta { font-size: 20px; color: #6b7280; font-weight: 600; margin-bottom: 10px; }
    .hero { font-size: 54px; line-height: 1.04; font-weight: 800; color: #111827; letter-spacing: -0.02em; margin-bottom: 24px; }
    #capture-root, article, #content-container, main.ant-layout-content, .style_content__Qif_T, .style_learn__wJdK1 .ant-layout { width: 100% !important; max-width: none !important; margin: 0 !important; }
    img, svg, canvas { max-width: 100% !important; height: auto !important; }
    pre { white-space: pre-wrap !important; overflow: visible !important; }
    code { white-space: pre-wrap !important; }
    table { max-width: 100% !important; width: 100% !important; table-layout: auto !important; }
    [style*="position: fixed"], [style*="position:sticky"], header, footer, aside, nav, .ant-layout-sider, .ant-layout-header, #USE_CHAT_GPT_AI_ROOT, use-chat-gpt-ai, [class*="ask-alex" i], [class*="AskAlex" i] { display: none !important; }
    #content-container, .style_learn__wJdK1, .style_learn__wJdK1 .ant-layout, .style_content__Qif_T, main.ant-layout-content, #content.style_articleWrap__Xn2yv { width: 100% !important; max-width: none !important; margin: 0 auto !important; padding: 0 !important; }
    article.style_learnContent__K5K7M { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
  </style>
</head>
<body>
  <div class="page">
    <div class="meta">alex_xu</div>
    <div class="hero">${String(title).replace(/</g, '&lt;')}</div>
    <div id="capture-root">${lessonRootHtml}</div>
  </div>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.locator('#capture-root').waitFor();
  await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : null);
  await page.waitForTimeout(1500);

  const target = page.locator('.page').first();
  const jpgPath = path.join(outDir, 'page.jpg');
  const pdfPath = path.join(outDir, 'page.pdf');
  await target.screenshot({ path: jpgPath, type: 'jpeg', quality: 95 });
  await page.pdf({ path: pdfPath, printBackground: true, width: '1800px', margin: { top: '16px', right: '16px', bottom: '16px', left: '16px' } });
  console.log(JSON.stringify({ ok: true, jpgPath, pdfPath, htmlPath }));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
