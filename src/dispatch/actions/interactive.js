'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { safeMkdir, sleep } = require('../../core/utils');

function downloadImage(src, destPath) {
  if (!src || src.startsWith('data:')) return false;
  const res = spawnSync('curl', ['-sL', '--max-time', '30', '--retry', '2', '-o', destPath, src], { timeout: 35000 });
  return res.status === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
}

async function discoverInteractiveWidgets(page) {
  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return rect.width > 80 && rect.height > 80 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    }

    function findNearestContainer(counterEl) {
      let el = counterEl;
      while (el && el !== document.body) {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const hasImages = el.querySelectorAll('img').length > 0;
        const hasButtons = el.querySelectorAll('button, [role="button"], a').length > 0;
        if (rect.width > 300 && rect.height > 250 && hasImages && hasButtons && text.includes('/')) {
          return el;
        }
        el = el.parentElement;
      }
      return counterEl.parentElement || counterEl;
    }

    function buttonLooksLikeNext(btn) {
      const txt = [btn.innerText, btn.getAttribute('aria-label'), btn.getAttribute('title')]
        .filter(Boolean).join(' ').trim().toLowerCase();
      const html = (btn.innerHTML || '').toLowerCase();
      return /next button|next slide|next|→|›|⟩/.test(txt) || /next slide|arrow|chevron/.test(html);
    }

    function buttonLooksLikePrev(btn) {
      const txt = [btn.innerText, btn.getAttribute('aria-label'), btn.getAttribute('title')]
        .filter(Boolean).join(' ').trim().toLowerCase();
      const html = (btn.innerHTML || '').toLowerCase();
      return /previous button|previous slide|prev|back|←|‹|⟨/.test(txt) || /previous slide/.test(html);
    }

    const counters = [...document.querySelectorAll('div, span, p, strong')].filter((el) => {
      if (!isVisible(el)) return false;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      return /^\d+\s*\/\s*\d+$/.test(text);
    });

    const found = [];
    let idx = 0;
    const seen = new Set();

    for (const counterEl of counters) {
      const container = findNearestContainer(counterEl);
      if (!container || !isVisible(container)) continue;
      const key = container.innerText.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);

      const buttons = [...container.querySelectorAll('button, [role="button"], a')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      });
      const nextBtn = buttons.find(buttonLooksLikeNext);
      if (!nextBtn) continue;
      const prevBtn = buttons.find(buttonLooksLikePrev) || null;

      idx += 1;
      const widgetId = `openclaw-interactive-${idx}`;
      container.setAttribute('data-openclaw-interactive-id', widgetId);
      nextBtn.setAttribute('data-openclaw-interactive-next', widgetId);
      if (prevBtn) prevBtn.setAttribute('data-openclaw-interactive-prev', widgetId);

      const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
      const imageUrls = [...container.querySelectorAll('img')]
        .map((img) => img.src || '')
        .filter((src) => src && !src.startsWith('data:'));

      found.push({
        widgetId,
        currentSlide: match ? Number(match[1]) : null,
        totalSlides: match ? Number(match[2]) : null,
        text: text.slice(0, 400),
        imageUrls,
      });
    }

    return found;
  });
}

async function waitForCounterChange(page, widgetId, previousText, timeoutMs = 35000) {
  try {
    await page.waitForFunction(
      ({ widgetIdInner, previousTextInner }) => {
        const el = document.querySelector(`[data-openclaw-interactive-id="${widgetIdInner}"]`);
        if (!el) return false;
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return text !== previousTextInner;
      },
      { timeout: timeoutMs },
      { widgetIdInner: widgetId, previousTextInner: previousText }
    );
  } catch {}
}

async function captureInteractiveWidgets(page, mediaDir, opts = {}) {
  safeMkdir(mediaDir);
  const perSlideDelayMs = Number(opts.perSlideDelayMs || 30000);
  const widgets = await discoverInteractiveWidgets(page);
  const captures = [];

  for (let i = 0; i < widgets.length; i++) {
    const widget = widgets[i];
    const widgetNum = String(i + 1).padStart(2, '0');
    const total = Math.min(widget.totalSlides || 1, 20);
    const files = [];

    for (let slide = 1; slide <= total; slide++) {
      const handle = await page.$(`[data-openclaw-interactive-id="${widget.widgetId}"]`);
      if (!handle) break;

      const shotFile = path.join(mediaDir, `interactive-${widgetNum}-slide-${String(slide).padStart(2, '0')}.png`);
      try {
        await handle.screenshot({ path: shotFile });
        if (fs.existsSync(shotFile) && fs.statSync(shotFile).size > 0) files.push(path.basename(shotFile));
      } catch {}

      const imageUrls = await page.evaluate((widgetId) => {
        const el = document.querySelector(`[data-openclaw-interactive-id="${widgetId}"]`);
        if (!el) return [];
        return [...el.querySelectorAll('img')]
          .map((img) => img.src || '')
          .filter((src) => src && !src.startsWith('data:'));
      }, widget.widgetId);

      let imgIndex = 0;
      for (const imageUrl of imageUrls) {
        imgIndex += 1;
        const imgFile = path.join(mediaDir, `interactive-${widgetNum}-slide-${String(slide).padStart(2, '0')}-img-${String(imgIndex).padStart(2, '0')}.png`);
        if (downloadImage(imageUrl, imgFile)) files.push(path.basename(imgFile));
      }

      if (slide >= total) break;

      const previousText = await page.evaluate((widgetId) => {
        const el = document.querySelector(`[data-openclaw-interactive-id="${widgetId}"]`);
        return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
      }, widget.widgetId);

      const clicked = await page.evaluate((widgetId) => {
        const btn = document.querySelector(`[data-openclaw-interactive-next="${widgetId}"]`);
        if (!btn) return false;
        btn.click();
        return true;
      }, widget.widgetId);

      if (!clicked) break;
      await waitForCounterChange(page, widget.widgetId, previousText, perSlideDelayMs + 5000);
      await sleep(perSlideDelayMs);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => {});
    }

    const meta = {
      widgetId: widget.widgetId,
      totalSlidesDetected: widget.totalSlides,
      perSlideDelayMs,
      files: [...new Set(files)],
      text: widget.text,
    };
    fs.writeFileSync(path.join(mediaDir, `interactive-${widgetNum}.json`), JSON.stringify(meta, null, 2));
    captures.push(meta);
  }

  return captures;
}

module.exports = {
  captureInteractiveWidgets,
};
