'use strict';

const fs = require('fs');
const path = require('path');
const { safeMkdir, sleep } = require('../../core/utils');

async function discoverInteractiveWidgets(page) {
  return await page.evaluate(() => {
    function isVisible(el, minW = 1, minH = 1) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return rect.width > minW && rect.height > minH && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    }
    function nearestWidgetContainer(nextBtn) {
      let el = nextBtn;
      while (el && el !== document.body) {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (rect.width > 300 && rect.height > 220 && /\b\d+\s*\/\s*\d+\b/.test(text)) return el;
        el = el.parentElement;
      }
      return nextBtn.parentElement || nextBtn;
    }
    const nextButtons = [...document.querySelectorAll('[data-testid="canvas-animation-next-slide"]')].filter((el) => isVisible(el, 10, 10));
    return nextButtons.map((nextBtn, idx) => {
      const container = nearestWidgetContainer(nextBtn);
      if (!container || !isVisible(container, 250, 180)) return null;
      const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
      if (!match) return null;
      return {
        ordinal: idx,
        currentSlide: Number(match[1]),
        totalSlides: Number(match[2]),
        text: text.slice(0, 400),
      };
    }).filter(Boolean);
  });
}

async function bindCurrentWidget(page, widgetOrdinal) {
  return await page.evaluate((widgetOrdinalInner) => {
    function isVisible(el, minW = 1, minH = 1) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return rect.width > minW && rect.height > minH && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    }
    function nearestWidgetContainer(nextBtn) {
      let el = nextBtn;
      while (el && el !== document.body) {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (rect.width > 300 && rect.height > 220 && /\b\d+\s*\/\s*\d+\b/.test(text)) return el;
        el = el.parentElement;
      }
      return nextBtn.parentElement || nextBtn;
    }

    document.querySelectorAll('[data-openclaw-capture-target]').forEach((el) => el.removeAttribute('data-openclaw-capture-target'));
    document.querySelectorAll('[data-openclaw-next-target]').forEach((el) => el.removeAttribute('data-openclaw-next-target'));

    const nextButtons = [...document.querySelectorAll('[data-testid="canvas-animation-next-slide"]')].filter((el) => isVisible(el, 10, 10));
    const nextBtn = nextButtons[widgetOrdinalInner];
    if (!nextBtn) return null;
    const container = nearestWidgetContainer(nextBtn);
    if (!container || !isVisible(container, 250, 180)) return null;
    container.setAttribute('data-openclaw-capture-target', '1');
    nextBtn.setAttribute('data-openclaw-next-target', '1');
    const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    return {
      text,
      counter: match ? match[0] : null,
      current: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null,
    };
  }, widgetOrdinal);
}

async function waitForCounterChange(page, widgetOrdinal, previousCounter, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await bindCurrentWidget(page, widgetOrdinal);
    if (state && state.counter && state.counter !== previousCounter) return state;
    await sleep(250);
  }
  return null;
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
    let successfulSlides = 0;

    for (let slide = 1; slide <= total; slide++) {
      const state = await bindCurrentWidget(page, widget.ordinal);
      const handle = await page.$('[data-openclaw-capture-target="1"]');
      if (!state || !handle) break;

      const shotFile = path.join(mediaDir, `interactive-${widgetNum}-slide-${String(slide).padStart(2, '0')}.png`);
      try {
        await handle.screenshot({ path: shotFile });
        if (fs.existsSync(shotFile) && fs.statSync(shotFile).size > 0) {
          files.push(path.basename(shotFile));
          successfulSlides += 1;
        }
      } catch {}

      if (slide >= total) break;

      const previousCounter = state.counter;
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-openclaw-next-target="1"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      if (!clicked) break;

      const changedState = await waitForCounterChange(page, widget.ordinal, previousCounter, perSlideDelayMs + 5000);
      if (!changedState) break;
      await sleep(perSlideDelayMs);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => {});
    }

    const meta = {
      ordinal: widget.ordinal,
      totalSlidesDetected: widget.totalSlides,
      successfulSlides,
      perSlideDelayMs,
      files,
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
