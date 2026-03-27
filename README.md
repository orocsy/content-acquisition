# content-acquisition

Browser-driven acquisition tools for structured learning content.

## Architecture

The project uses a **provider/dispatch** architecture that makes it easy to add
new content sources without touching the core scraping logic.

```
src/
├── core/           # Provider-agnostic utilities and state management
│   ├── provider.js     # BaseProvider contract (extend to add a new provider)
│   ├── course-map.js   # Course graph/curriculum cache (course-map.json)
│   ├── pdf-pack-builder.js # NotebookLM-ready merged PDF pack planner/builder
│   ├── state.js        # Resume state + manifest management
│   └── utils.js        # Shared helpers (fs, sleep, slugify, etc.)
│
├── providers/      # One directory per content platform
│   └── educative/
│       ├── index.js    # EducativeProvider (extends BaseProvider)
│       └── lib/
│           ├── curriculum.js   # PAL API + mini-map curriculum discovery
│           ├── navigation.js   # Page structure discovery + next-button clicking
│           └── utils.js        # Educative-specific URL normalization
│
├── dispatch/       # Action orchestration
│   ├── registry.js         # registerProvider / getProvider
│   └── actions/
│       ├── scrape.js   # Main sequential scrape flow
│       ├── patch.js    # Post-scrape patch (re-process existing lessons)
│       ├── pdf.js      # PDF capture helper
│       └── video.js    # Video interception + yt-dlp download
│
└── cli/            # Thin CLI entry points
    ├── scrape.js          # node src/cli/scrape.js --url <url> [options]
    ├── patch.js           # node src/cli/patch.js --course-dir <path> [options]
    ├── notebooklm-plan.js # dry-run pack planning under NotebookLM file-size limits
    └── merge-pdfs.js      # build/update merged NotebookLM-ready PDF packs

scripts/            # Legacy shell runners + PM2 config (still working)
```

### Key concepts

| Concept | Where | Description |
|---------|-------|-------------|
| **Provider** | `src/providers/<name>/` | Encapsulates everything platform-specific: URL normalization, auth (cookies), stealth patches, curriculum discovery, page navigation |
| **scrape** | `src/dispatch/actions/scrape.js` | Ordered lesson acquisition loop. Browser-driven, resumable, curriculum-guided |
| **patch** | `src/dispatch/actions/patch.js` | Re-process already-captured lessons without a full scrape run |
| **pdf** | `src/dispatch/actions/pdf.js` | Capture a Puppeteer PDF of the current page |
| **video** | `src/dispatch/actions/video.js` | Intercept streaming URLs + yt-dlp download |
| **notebooklm-plan** | `src/cli/notebooklm-plan.js` | Dry-run planner: estimate how many merged PDFs are needed under the configured file-size cap |
| **merge-pdfs** | `src/cli/merge-pdfs.js` | Build or incrementally update merged PDF packs with optional blank-page separators |
| **course-map** | `src/core/course-map.js` | Persistent graph of discovered URLs and curriculum order |
| **state** | `src/core/state.js` | `.resume-state.json` + `manifest.json` bookkeeping |
| **registry** | `src/dispatch/registry.js` | Maps provider names → instances |

## Adding a new provider

1. Create `src/providers/<name>/index.js` extending `BaseProvider`.
2. Implement at minimum:
   - `normalizeUrl(url)`
   - `courseSlugFromUrl(url)`
   - `lessonSlugFromUrl(url)`
   - `isCourseLessonUrl(url, ctx)`
   - `buildCourseContext(startUrl)` → `{ coursePrefix, courseSlug }`
   - `applyAuth(page, url)`
   - `discoverCurriculum(page, ctx)` → `{ orderedLessons, source }`
   - `clickNextLesson(page, ctx)` → `{ ok, url, reason }`
3. Register it in `src/cli/scrape.js`:
   ```js
   registerProvider(require('../providers/hellointerview'));
   ```
4. Run with `--provider hellointerview`.

See `src/core/provider.js` for the full contract with JSDoc.

## Environment

Optional environment variables:

- `CONTENT_ACQUISITION_OUT_DIR` — default output directory for scraped content
- `CHROME_PATH` or `BROWSER_EXECUTABLE_PATH` — explicit browser binary path if Puppeteer should not auto-detect one

Example:

```bash
export CONTENT_ACQUISITION_OUT_DIR="$HOME/Documents/educative"
export CHROME_PATH="/path/to/chrome"
```

## Install

```bash
npm install
```

## Scrape a course

```bash
# New CLI (provider-aware)
node src/cli/scrape.js \
  --provider educative \
  --url "https://www.educative.io/interview-prep/system-design/introduction-to-modern-system-design" \
  --out-dir "$CONTENT_ACQUISITION_OUT_DIR" \
  --min-delay-ms 60000 \
  --max-delay-ms 180000

# Or via npm script
npm run scrape -- --url "https://..." --out-dir "$CONTENT_ACQUISITION_OUT_DIR"
```

### Patch existing lessons

```bash
node src/cli/patch.js \
  --provider educative \
  --course-dir "$CONTENT_ACQUISITION_OUT_DIR/system-design" \
  --skip-videos
```

## NotebookLM-ready merged PDF packs

This project can maintain a second layer of output specifically for NotebookLM:
small lesson PDFs stay untouched, while merged "pack" PDFs are built from them.

Why this exists:
- NotebookLM works better with fewer, larger sources than hundreds of tiny PDFs
- each uploaded file must stay under NotebookLM's file-size limit
- a single notebook can then hold a much more complete course knowledge base

### Phase 1: pre-check / dry-run plan

```bash
node src/cli/notebooklm-plan.js \
  --root "$CONTENT_ACQUISITION_OUT_DIR/system-design" \
  --out-dir "$CONTENT_ACQUISITION_OUT_DIR/system-design/_notebooklm" \
  --prefix system-design-pack \
  --max-bytes 180000000 \
  --reserve-bytes 10000000
```

This recursively finds `page.pdf` files, sorts them by path, and estimates how
many merged packs are needed before building anything.

### Phase 2: build merged packs

```bash
node src/cli/merge-pdfs.js \
  --root "$CONTENT_ACQUISITION_OUT_DIR/system-design" \
  --out-dir "$CONTENT_ACQUISITION_OUT_DIR/system-design/_notebooklm" \
  --prefix system-design-pack \
  --max-bytes 180000000 \
  --reserve-bytes 10000000 \
  --separator blank
```

Behavior:
- recursively finds lesson PDFs under `--root`
- keeps the original tiny PDFs unchanged
- inserts a blank page between merged lessons when `--separator blank`
- writes a manifest to `<out-dir>/manifest.json`
- removes obsolete pack PDFs when rebuilding

### Phase 3: incremental update after scraping

The scrape CLI can update merged packs after each successful lesson PDF:

```bash
node src/cli/scrape.js \
  --provider educative \
  --url "https://www.educative.io/interview-prep/system-design/introduction-to-modern-system-design" \
  --out-dir "$CONTENT_ACQUISITION_OUT_DIR" \
  --notebooklm-pack \
  --pack-max-bytes 180000000 \
  --pack-reserve-bytes 10000000 \
  --pack-separator blank
```

This keeps `<courseDir>/_notebooklm/` up to date incrementally as new lesson
PDFs are captured.

## PM2

PM2 wrappers remain in `scripts/`.

### Generic Educative course wrapper

Set the course URL and optional output/app-name env vars, then start the generic PM2 config:

```bash
export COURSE_URL="https://www.educative.io/interview-prep/system-design/introduction-to-modern-system-design"
export COURSE_NAME="system-design"
export PM2_APP_NAME="educative-system-design"
export NOTEBOOKLM_PACK=1
pm2 start scripts/pm2-educative-course.config.cjs
pm2 logs "$PM2_APP_NAME"
```

### Existing course-specific wrapper

The older system-design-specific config still works too:

```bash
pm2 start scripts/pm2-educative-system-design.config.cjs
pm2 logs educative-system-design
```

If you prefer to run the new Node CLI directly via PM2, point `script` at
`src/cli/scrape.js` and set `interpreter: 'node'`.

## Key behavior (preserved)

- **Resumable** — `.resume-state.json` tracks last position; re-run picks up where it left off
- **Course-map caching** — `course-map.json` persists the full URL graph; curriculum is not re-discovered unless `--refresh-curriculum` is passed
- **Full-path traversal** — curriculum order is used when available; breakout/mock interview items are skipped by the navigation heuristics
- **Cookie injection** — reads from local Chrome profile via `chrome-cookies-secure`
- **Video download** — `yt-dlp` is called per lesson when streaming URLs are found
- **PM2 support** — shell scripts in `scripts/` handle notify-on-completion and PM2 cleanup

## Legacy entry points (still work)

The original scripts remain untouched for backward compatibility:

- `scripts/educative-sequential-scrape.js` — original monolithic scraper
- `scripts/run-educative-course.sh` — generic shell wrapper
- `scripts/run-educative-system-design.sh` — course-specific runner
- `scripts/pm2-educative-course.config.cjs` — generic PM2 config for any Educative course
- `scripts/pm2-educative-system-design.config.cjs` — older course-specific PM2 config
