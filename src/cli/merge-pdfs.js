#!/usr/bin/env node
'use strict';

const {
  resolveOptions,
  mergeNotebookLmPacks,
  appendIncrementalPdf,
  humanBytes,
} = require('../core/pdf-pack-builder');

function expandHome(value) {
  return value ? value.replace(/^~/, process.env.HOME) : value;
}

function parseArgs(argv) {
  const args = {
    root: null,
    outDir: null,
    pattern: 'page.pdf',
    recursive: true,
    maxBytes: 180_000_000,
    reserveBytes: 10_000_000,
    separator: 'blank',
    prefix: 'pack',
    sort: 'path',
    incrementalPdf: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--root' && n) { args.root = expandHome(n); i++; }
    else if (a === '--out-dir' && n) { args.outDir = expandHome(n); i++; }
    else if (a === '--pattern' && n) { args.pattern = n; i++; }
    else if (a === '--max-bytes' && n) { args.maxBytes = Number(n); i++; }
    else if (a === '--reserve-bytes' && n) { args.reserveBytes = Number(n); i++; }
    else if (a === '--separator' && n) { args.separator = n; i++; }
    else if (a === '--prefix' && n) { args.prefix = n; i++; }
    else if (a === '--sort' && n) { args.sort = n; i++; }
    else if (a === '--incremental-pdf' && n) { args.incrementalPdf = expandHome(n); i++; }
    else if (a === '--no-recursive') args.recursive = false;
    else if (a === '--json') args.json = true;
  }

  if (!args.root) {
    console.error('Usage: node src/cli/merge-pdfs.js --root <dir> [options]');
    process.exit(1);
  }

  return resolveOptions(args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.incrementalPdf
    ? await appendIncrementalPdf(options)
    : await mergeNotebookLmPacks(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Built ${result.packs.length} NotebookLM pack(s) in ${result.outDir}`);
  for (const pack of result.packs) {
    console.log(`- ${pack.file}  ${humanBytes(pack.bytes)}  ${pack.sourceCount} source(s)`);
  }
  if (result.warnings?.length) {
    console.log('Warnings:');
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
