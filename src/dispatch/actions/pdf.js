'use strict';

/**
 * dispatch/actions/pdf.js — PDF capture action.
 *
 * Captures a puppeteer PDF of the current page.
 * Returns { ok: bool, path: string, bytes: number }.
 */

const fs = require('fs');

async function capturePdf(page, outputPath, opts = {}) {
  await page.pdf({
    path: outputPath,
    printBackground: true,
    preferCSSPageSize: true,
    format: opts.format || 'A4',
  });
  let bytes = 0;
  try { bytes = fs.statSync(outputPath).size; } catch {}
  return { ok: bytes > 0, path: outputPath, bytes };
}

module.exports = { capturePdf };
