'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { safeMkdir, readJson, writeJson } = require('./utils');

const DEFAULTS = {
  pattern: 'page.pdf',
  recursive: true,
  separator: 'blank',
  maxBytes: 180_000_000,
  reserveBytes: 10_000_000,
  manifestName: 'manifest.json',
  prefix: 'pack',
  sort: 'path',
};

const ESTIMATED_MERGE_OVERHEAD_BYTES = 4096;
const ESTIMATED_BLANK_PAGE_BYTES = 2048;

function resolveOptions(options = {}) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir || path.join(root, '_notebooklm'));
  return {
    ...DEFAULTS,
    ...options,
    root,
    outDir,
    maxBytes: Number(options.maxBytes || DEFAULTS.maxBytes),
    reserveBytes: Number(options.reserveBytes ?? DEFAULTS.reserveBytes),
  };
}

function effectiveLimitBytes(options) {
  return Math.max(1, options.maxBytes - options.reserveBytes);
}

function manifestPathFor(options) {
  return path.join(options.outDir, options.manifestName || DEFAULTS.manifestName);
}

function packFileName(prefix, index) {
  return `${prefix}-${String(index).padStart(3, '0')}.pdf`;
}

function sourceKey(root, absPath) {
  return path.relative(root, absPath);
}

function getFileInfo(root, absPath) {
  const stat = fs.statSync(absPath);
  return {
    absPath,
    relPath: sourceKey(root, absPath),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function discoverPdfSources(options = {}) {
  const opts = resolveOptions(options);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (path.resolve(full).startsWith(path.resolve(opts.outDir))) continue;
      if (entry.isDirectory()) {
        if (opts.recursive) walk(full);
        continue;
      }
      if (entry.name !== opts.pattern) continue;
      out.push(getFileInfo(opts.root, full));
    }
  };
  walk(opts.root);
  return sortSources(out, opts.sort);
}

function sortSources(items, mode = 'path') {
  const copy = [...items];
  if (mode === 'mtime') {
    return copy.sort((a, b) => a.mtimeMs - b.mtimeMs || a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
  }
  return copy.sort((a, b) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true }));
}

async function buildMergedPdfBuffer(sources, options = {}) {
  const opts = resolveOptions({ root: options.root || process.cwd(), outDir: options.outDir || process.cwd(), ...options });
  const merged = await PDFDocument.create();

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const bytes = fs.readFileSync(source.absPath || source.path || source);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(pdf, pdf.getPageIndices());

    if (i > 0 && opts.separator === 'blank') {
      const firstPage = pages[0];
      const width = firstPage ? firstPage.getWidth() : 595.28;
      const height = firstPage ? firstPage.getHeight() : 841.89;
      merged.addPage([width, height]);
    }

    for (const page of pages) merged.addPage(page);
  }

  return Buffer.from(await merged.save());
}

async function buildPackCandidate(sources, options) {
  const buffer = await buildMergedPdfBuffer(sources, options);
  return {
    bytes: buffer.length,
    buffer,
    withinLimit: buffer.length <= effectiveLimitBytes(options),
    sources,
  };
}

function estimateMergedBytes(sources, options = {}) {
  const separatorCount = options.separator === 'blank' ? Math.max(0, sources.length - 1) : 0;
  const sourceBytes = sources.reduce((sum, source) => sum + Number(source.bytes || 0), 0);
  return sourceBytes + ESTIMATED_MERGE_OVERHEAD_BYTES + (separatorCount * ESTIMATED_BLANK_PAGE_BYTES);
}

async function planNotebookLmPacks(options = {}) {
  const opts = resolveOptions(options);
  const sources = options.sources ? sortSources(options.sources, opts.sort) : discoverPdfSources(opts);
  const packs = [];
  const warnings = [];

  if (sources.length === 0) {
    return {
      ok: true,
      root: opts.root,
      outDir: opts.outDir,
      sourceCount: 0,
      packs: [],
      warnings: ['No matching PDFs found'],
      effectiveLimitBytes: effectiveLimitBytes(opts),
    };
  }

  let currentSources = [sources[0]];
  let currentEstimatedBytes = estimateMergedBytes(currentSources, opts);
  if (currentEstimatedBytes > effectiveLimitBytes(opts)) {
    warnings.push(`Single PDF exceeds effective limit: ${sources[0].relPath}`);
  }

  for (let i = 1; i < sources.length; i++) {
    const source = sources[i];
    const candidateSources = [...currentSources, source];
    const candidateBytes = estimateMergedBytes(candidateSources, opts);

    if (candidateBytes <= effectiveLimitBytes(opts)) {
      currentSources = candidateSources;
      currentEstimatedBytes = candidateBytes;
      continue;
    }

    packs.push({
      index: packs.length + 1,
      file: packFileName(opts.prefix, packs.length + 1),
      estimatedBytes: currentEstimatedBytes,
      sourceCount: currentSources.length,
      sources: currentSources.map(minifySource),
    });

    currentSources = [source];
    currentEstimatedBytes = estimateMergedBytes(currentSources, opts);
    if (currentEstimatedBytes > effectiveLimitBytes(opts)) {
      warnings.push(`Single PDF exceeds effective limit: ${source.relPath}`);
    }
  }

  packs.push({
    index: packs.length + 1,
    file: packFileName(opts.prefix, packs.length + 1),
    estimatedBytes: currentEstimatedBytes,
    sourceCount: currentSources.length,
    sources: currentSources.map(minifySource),
  });

  return {
    ok: true,
    root: opts.root,
    outDir: opts.outDir,
    sourceCount: sources.length,
    packs,
    warnings,
    effectiveLimitBytes: effectiveLimitBytes(opts),
    maxBytes: opts.maxBytes,
    reserveBytes: opts.reserveBytes,
  };
}

async function executeNotebookLmPackPlan(plan, options = {}) {
  const opts = resolveOptions({ root: plan.root, outDir: plan.outDir, ...options });
  safeMkdir(opts.outDir);

  const warnings = [...(plan.warnings || [])];
  const finalizedPacks = [];
  for (const pack of plan.packs) {
    const sources = pack.sources.map((source) => ({
      ...source,
      absPath: path.join(opts.root, source.relPath),
    }));
    const refined = await refinePackSourcesToFit(sources, opts, warnings);
    for (const entry of refined) finalizedPacks.push(entry);
  }

  const writtenPacks = [];
  for (let i = 0; i < finalizedPacks.length; i++) {
    const pack = finalizedPacks[i];
    const file = packFileName(opts.prefix, i + 1);
    const filePath = path.join(opts.outDir, file);
    fs.writeFileSync(filePath, pack.buffer);
    const bytes = fs.statSync(filePath).size;
    writtenPacks.push({
      index: i + 1,
      file,
      path: filePath,
      bytes,
      estimatedBytes: estimateMergedBytes(pack.sources, opts),
      sourceCount: pack.sources.length,
      withinLimit: bytes <= effectiveLimitBytes(opts),
      sources: pack.sources.map(minifySource),
    });
  }

  cleanupObsoletePacks(opts.outDir, writtenPacks.map((p) => p.file), opts.prefix);

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: opts.root,
    outDir: opts.outDir,
    prefix: opts.prefix,
    pattern: opts.pattern,
    recursive: opts.recursive,
    separator: opts.separator,
    maxBytes: opts.maxBytes,
    reserveBytes: opts.reserveBytes,
    effectiveLimitBytes: effectiveLimitBytes(opts),
    sourceCount: writtenPacks.reduce((sum, pack) => sum + pack.sourceCount, 0),
    warningCount: warnings.length,
    warnings,
    packs: writtenPacks.map((pack) => ({
      index: pack.index,
      file: pack.file,
      bytes: pack.bytes,
      estimatedBytes: pack.estimatedBytes,
      sourceCount: pack.sourceCount,
      withinLimit: pack.withinLimit,
      sources: pack.sources,
    })),
  };

  writeJson(manifestPathFor(opts), manifest);
  return manifest;
}

async function refinePackSourcesToFit(sources, options, warnings = []) {
  const candidate = await buildPackCandidate(sources, options);
  if (candidate.withinLimit) {
    return [{ sources, buffer: candidate.buffer, bytes: candidate.bytes }];
  }

  if (sources.length <= 1) {
    warnings.push(`Single PDF still exceeds effective limit after build: ${sources[0].relPath}`);
    return [{ sources, buffer: candidate.buffer, bytes: candidate.bytes }];
  }

  const midpoint = Math.ceil(sources.length / 2);
  const left = await refinePackSourcesToFit(sources.slice(0, midpoint), options, warnings);
  const right = await refinePackSourcesToFit(sources.slice(midpoint), options, warnings);
  return [...left, ...right];
}

function cleanupObsoletePacks(outDir, keepFiles, prefix) {
  const keep = new Set(keepFiles);
  if (!fs.existsSync(outDir)) return;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(`${prefix}-`) || !entry.name.endsWith('.pdf')) continue;
    if (keep.has(entry.name)) continue;
    fs.unlinkSync(path.join(outDir, entry.name));
  }
}

async function mergeNotebookLmPacks(options = {}) {
  const opts = resolveOptions(options);
  const plan = await planNotebookLmPacks(opts);
  return executeNotebookLmPackPlan(plan, opts);
}

async function appendIncrementalPdf(options = {}) {
  const opts = resolveOptions(options);
  const pdfPath = path.resolve(options.incrementalPdf);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`incrementalPdf does not exist: ${pdfPath}`);
  }

  const manifest = readJson(manifestPathFor(opts), null);
  if (!manifest || !Array.isArray(manifest.packs)) {
    return mergeNotebookLmPacks(opts);
  }

  const relPath = sourceKey(opts.root, pdfPath);
  const fileInfo = getFileInfo(opts.root, pdfPath);
  const alreadyPresent = manifest.packs.some((pack) =>
    (pack.sources || []).some((source) => source.relPath === relPath && Number(source.bytes) === fileInfo.bytes)
  );
  if (alreadyPresent) {
    return manifest;
  }

  const allSources = discoverPdfSources(opts);
  const knownKeys = new Set();
  for (const pack of manifest.packs) {
    for (const source of pack.sources || []) knownKeys.add(source.relPath);
  }
  if (![...knownKeys].every((key) => allSources.some((source) => source.relPath === key))) {
    return mergeNotebookLmPacks(opts);
  }

  const lastPack = manifest.packs[manifest.packs.length - 1];
  const lastPackSources = (lastPack?.sources || []).map((source) => ({
    ...source,
    absPath: path.join(opts.root, source.relPath),
  }));
  const candidateSources = [...lastPackSources, fileInfo];

  safeMkdir(opts.outDir);

  if (estimateMergedBytes(candidateSources, opts) <= effectiveLimitBytes(opts)) {
    const candidate = await buildPackCandidate(candidateSources, opts);
    if (candidate.withinLimit) {
      const outFile = path.join(opts.outDir, lastPack.file);
      fs.writeFileSync(outFile, candidate.buffer);
      lastPack.bytes = candidate.bytes;
      lastPack.estimatedBytes = estimateMergedBytes(candidateSources, opts);
      lastPack.sourceCount = candidateSources.length;
      lastPack.withinLimit = true;
      lastPack.sources = candidateSources.map(minifySource);
    } else {
      const nextIndex = manifest.packs.length + 1;
      const buffer = await buildMergedPdfBuffer([fileInfo], opts);
      const file = packFileName(opts.prefix, nextIndex);
      fs.writeFileSync(path.join(opts.outDir, file), buffer);
      manifest.packs.push({
        index: nextIndex,
        file,
        bytes: buffer.length,
        estimatedBytes: estimateMergedBytes([fileInfo], opts),
        sourceCount: 1,
        withinLimit: buffer.length <= effectiveLimitBytes(opts),
        sources: [minifySource(fileInfo)],
      });
    }
  } else {
    const nextIndex = manifest.packs.length + 1;
    const buffer = await buildMergedPdfBuffer([fileInfo], opts);
    const file = packFileName(opts.prefix, nextIndex);
    fs.writeFileSync(path.join(opts.outDir, file), buffer);
    manifest.packs.push({
      index: nextIndex,
      file,
      bytes: buffer.length,
      estimatedBytes: estimateMergedBytes([fileInfo], opts),
      sourceCount: 1,
      withinLimit: buffer.length <= effectiveLimitBytes(opts),
      sources: [minifySource(fileInfo)],
    });
  }

  manifest.generatedAt = new Date().toISOString();
  manifest.root = opts.root;
  manifest.outDir = opts.outDir;
  manifest.prefix = opts.prefix;
  manifest.pattern = opts.pattern;
  manifest.recursive = opts.recursive;
  manifest.separator = opts.separator;
  manifest.maxBytes = opts.maxBytes;
  manifest.reserveBytes = opts.reserveBytes;
  manifest.effectiveLimitBytes = effectiveLimitBytes(opts);
  manifest.sourceCount = manifest.packs.reduce((sum, pack) => sum + (pack.sourceCount || 0), 0);
  writeJson(manifestPathFor(opts), manifest);
  return manifest;
}

function minifySource(source) {
  return {
    relPath: source.relPath,
    bytes: source.bytes,
    mtimeMs: source.mtimeMs,
  };
}

function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

module.exports = {
  DEFAULTS,
  resolveOptions,
  effectiveLimitBytes,
  manifestPathFor,
  packFileName,
  discoverPdfSources,
  sortSources,
  buildMergedPdfBuffer,
  buildPackCandidate,
  planNotebookLmPacks,
  executeNotebookLmPackPlan,
  mergeNotebookLmPacks,
  appendIncrementalPdf,
  humanBytes,
};
