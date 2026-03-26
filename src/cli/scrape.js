#!/usr/bin/env node
'use strict';

/**
 * cli/scrape.js — CLI entry point for the scrape action.
 *
 * Usage:
 *   node src/cli/scrape.js --provider educative --url <url> [options]
 *
 * Options:
 *   --provider <name>         Provider to use (default: educative)
 *   --url <url>               Starting lesson URL (required)
 *   --out-dir <path>          Base output directory (default: ~/Documents/educative)
 *   --executable-path <path>  Browser binary path
 *   --timeout-ms <n>          Navigation timeout in ms (default: 60000)
 *   --min-delay-ms <n>        Min delay between lessons (default: 60000)
 *   --max-delay-ms <n>        Max delay between lessons (default: 180000)
 *   --headful                 Run browser in headed mode
 *   --skip-videos             Skip video downloads
 *   --skip-pdf                Skip PDF generation
 *   --no-resume               Start fresh (ignore saved state)
 *   --refresh-curriculum      Re-discover curriculum even if cached
 */

const os = require('os');
const path = require('path');
const { getProvider, registerProvider } = require('../dispatch/registry');
const { runScrape } = require('../dispatch/actions/scrape');

// Register known providers
registerProvider(require('../providers/educative'));

const DEFAULT_OUT_DIR = path.join(process.env.HOME || os.homedir(), 'Documents/educative');

function parseArgs(argv) {
  const args = {
    provider: 'educative',
    url: null,
    outDir: DEFAULT_OUT_DIR,
    executablePath: undefined,
    headless: true,
    timeoutMs: 60000,
    minDelayMs: 60000,
    maxDelayMs: 180000,
    skipVideos: false,
    skipPdf: false,
    resume: true,
    refreshCurriculum: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = argv[i + 1];
    if (a === '--provider' && n) { args.provider = n; i++; }
    else if (a === '--url' && n) { args.url = n; i++; }
    else if (a === '--out-dir' && n) { args.outDir = n.replace(/^~/, process.env.HOME); i++; }
    else if (a === '--executable-path' && n) { args.executablePath = n; i++; }
    else if (a === '--timeout-ms' && n) { args.timeoutMs = Number(n); i++; }
    else if (a === '--min-delay-ms' && n) { args.minDelayMs = Number(n); i++; }
    else if (a === '--max-delay-ms' && n) { args.maxDelayMs = Number(n); i++; }
    else if (a === '--headful') args.headless = false;
    else if (a === '--headless') args.headless = true;
    else if (a === '--skip-videos') args.skipVideos = true;
    else if (a === '--skip-pdf') args.skipPdf = true;
    else if (a === '--no-resume') args.resume = false;
    else if (a === '--refresh-curriculum') args.refreshCurriculum = true;
  }

  if (!args.url) {
    console.error('Usage: node src/cli/scrape.js --url <lesson-url> [--provider educative] [options]');
    console.error('');
    console.error('Options:');
    console.error('  --provider <name>         Provider (default: educative)');
    console.error('  --out-dir <path>          Output directory');
    console.error('  --min-delay-ms <n>        Min delay between lessons');
    console.error('  --max-delay-ms <n>        Max delay between lessons');
    console.error('  --headful                 Headed browser mode');
    console.error('  --skip-videos             Skip video downloads');
    console.error('  --skip-pdf                Skip PDF generation');
    console.error('  --no-resume               Ignore saved state');
    console.error('  --refresh-curriculum      Re-discover curriculum');
    process.exit(1);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = getProvider(args.provider);
  const result = await runScrape({ ...args, provider });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
