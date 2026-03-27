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
    ├── scrape.js   # node src/cli/scrape.js --url <url> [options]
    └── patch.js    # node src/cli/patch.js --course-dir <path> [options]

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

## PM2

PM2 configs and shell runners remain in `scripts/` and continue to work.
They point to the legacy `scripts/educative-sequential-scrape.js` entry point
which still functions independently.

```bash
pm2 start scripts/pm2-educative-system-design.config.cjs
pm2 logs educative-system-design
```

To run the new CLI via PM2, update the `script` path in the config to
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
- `scripts/pm2-educative-system-design.config.cjs` — PM2 config
