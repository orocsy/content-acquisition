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
 *   --out-dir <path>          Base output directory (default: $CONTENT_ACQUISITION_OUT_DIR or ~/Documents/educative)
 *   --executable-path <path>  Browser binary path
 *   --timeout-ms <n>          Navigation timeout in ms (default: 60000)
 *   --min-delay-ms <n>        Min delay between lessons (default: 60000)
 *   --max-delay-ms <n>        Max delay between lessons (default: 180000)
 *   --headful                 Run browser in headed mode
 *   --skip-videos             Skip video downloads
 *   --skip-pdf                Skip PDF generation
 *   --no-resume               Start fresh (ignore saved state)
 *   --refresh-curriculum      Re-discover curriculum even if cached
 *   --notebooklm-pack         Incrementally maintain merged NotebookLM-ready PDFs
 *   --pack-out-dir <path>     Output dir for merged packs (default: <courseDir>/_notebooklm)
 *   --pack-max-bytes <n>      Max uploaded-file bytes target before reserve (default: 180000000)
 *   --pack-reserve-bytes <n>  Headroom reserved below max (default: 10000000)
 *   --pack-separator <mode>   blank|none (default: blank)
 */

const os = require('os');
const path = require('path');
const { getProvider, registerProvider } = require('../dispatch/registry');
const { runScrape } = require('../dispatch/actions/scrape');

// Register known providers
registerProvider(require('../providers/educative'));

const DEFAULT_OUT_DIR = process.env.CONTENT_ACQUISITION_OUT_DIR || path.join(process.env.HOME || os.homedir(), 'Documents/educative');

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
    notebooklmPack: false,
    packOutDir: undefined,
    packMaxBytes: 180000000,
    packReserveBytes: 10000000,
    packSeparator: 'blank',
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
    else if (a === '--notebooklm-pack') args.notebooklmPack = true;
    else if (a === '--pack-out-dir' && n) { args.packOutDir = n.replace(/^~/, process.env.HOME); i++; }
    else if (a === '--pack-max-bytes' && n) { args.packMaxBytes = Number(n); i++; }
    else if (a === '--pack-reserve-bytes' && n) { args.packReserveBytes = Number(n); i++; }
    else if (a === '--pack-separator' && n) { args.packSeparator = n; i++; }
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
    console.error('  --notebooklm-pack         Maintain merged NotebookLM-ready PDFs');
    console.error('  --pack-out-dir <path>     Pack output directory');
    console.error('  --pack-max-bytes <n>      Pack max bytes before reserve');
    console.error('  --pack-reserve-bytes <n>  Headroom below pack max');
    console.error('  --pack-separator <mode>   blank|none');
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
