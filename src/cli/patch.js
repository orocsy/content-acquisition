#!/usr/bin/env node
'use strict';

/**
 * cli/patch.js — CLI entry point for the patch action.
 *
 * Re-processes already-captured lessons to fix missing PDFs or re-download
 * videos without re-running the full scrape.
 *
 * Usage:
 *   node src/cli/patch.js --provider educative --course-dir <path> [options]
 *
 * Options:
 *   --provider <name>         Provider (default: educative)
 *   --course-dir <path>       Path to captured course directory (required)
 *   --actions <list>          Comma-separated patch actions: pdf,video,interactive (default: pdf,video,interactive)
 *   --numbers <list>          Lesson indexes to patch, e.g. 52,88
 *   --include-incomplete      Also patch lessons without a valid PDF (default: false)
 *   --timeout-ms <n>          Navigation timeout (default: 60000)
 *   --headful                 Run browser in headed mode
 *   --executable-path <path>  Browser binary path
 */

const { getProvider, registerProvider } = require('../dispatch/registry');
const { runPatch } = require('../dispatch/actions/patch');

function normalizeActions(raw) {
  const input = String(raw || 'pdf,video,interactive').trim().toLowerCase();
  const valid = new Set(['pdf', 'video', 'interactive']);
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = parts.filter((p) => valid.has(p));
  return chosen.length ? chosen : ['pdf', 'video'];
}

registerProvider(require('../providers/educative'));

function parseArgs(argv) {
  const args = {
    provider: 'educative',
    courseDir: null,
    actions: ['pdf', 'video', 'interactive'],
    includeIncomplete: false,
    numbers: null,
    timeoutMs: 60000,
    headless: true,
    executablePath: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--provider' && n) { args.provider = n; i++; }
    else if (a === '--course-dir' && n) { args.courseDir = n.replace(/^~/, process.env.HOME); i++; }
    else if (a === '--actions' && n) { args.actions = normalizeActions(n); i++; }
    else if (a === '--numbers' && n) { args.numbers = new Set(n.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))); i++; }
    else if (a === '--include-incomplete') args.includeIncomplete = true;
    else if (a === '--timeout-ms' && n) { args.timeoutMs = Number(n); i++; }
    else if (a === '--headful') args.headless = false;
    else if (a === '--executable-path' && n) { args.executablePath = n; i++; }
  }

  if (!args.courseDir) {
    console.error('Usage: node src/cli/patch.js --course-dir <path> [--provider educative] [options]');
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = getProvider(args.provider);
  const filter = args.numbers
    ? (lesson) => args.numbers.has(Number(lesson.index))
    : undefined;
  const result = await runPatch({ ...args, provider, filter });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
