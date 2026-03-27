#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  resolveOptions,
  planNotebookLmPacks,
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
    else if (a === '--no-recursive') args.recursive = false;
    else if (a === '--json') args.json = true;
  }

  if (!args.root) {
    console.error('Usage: node src/cli/notebooklm-plan.js --root <dir> [options]');
    process.exit(1);
  }

  return resolveOptions(args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = await planNotebookLmPacks(options);

  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`NotebookLM pack plan for: ${options.root}`);
  console.log(`Output dir: ${options.outDir}`);
  console.log(`Source count: ${plan.sourceCount}`);
  console.log(`Effective limit: ${humanBytes(plan.effectiveLimitBytes)} (max ${humanBytes(plan.maxBytes)} - reserve ${humanBytes(plan.reserveBytes)})`);
  console.log(`Pack count: ${plan.packs.length}`);
  console.log('');

  for (const pack of plan.packs) {
    const first = pack.sources[0]?.relPath || '-';
    const last = pack.sources[pack.sources.length - 1]?.relPath || '-';
    console.log(`${pack.file}  ~${humanBytes(pack.estimatedBytes)}  ${pack.sourceCount} source(s)`);
    console.log(`  from: ${first}`);
    console.log(`  to:   ${last}`);
  }

  if (plan.warnings.length) {
    console.log('');
    console.log('Warnings:');
    for (const warning of plan.warnings) console.log(`- ${warning}`);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
