#!/bin/zsh
set -euo pipefail

# Generic wrapper for future courses.
# Usage:
#   COURSE_URL="https://www.educative.io/..." COURSE_NAME="my-course" ./scripts/run-educative-course.sh

if [[ -z "${COURSE_URL:-}" ]]; then
  echo "COURSE_URL is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-${CONTENT_ACQUISITION_OUT_DIR:-$HOME/Documents/educative}}"
COURSE_NAME="${COURSE_NAME:-$(basename "$COURSE_URL")}" 
APP_NAME="${PM2_APP_NAME:-educative-course}"

cd "$REPO_ROOT"

notify_done() {
  local title="$1"
  local body="$2"
  /usr/bin/osascript -e "display notification \"${body//\"/\\\"}\" with title \"${title//\"/\\\"}\"" >/dev/null 2>&1 || true
}

cleanup_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  fi
}

SCRAPE_ARGS=(
  --provider educative
  --url "$COURSE_URL"
  --out-dir "$OUT_DIR"
  --min-delay-ms 60000
  --max-delay-ms 180000
)

if [[ "${NOTEBOOKLM_PACK:-0}" == "1" ]]; then
  SCRAPE_ARGS+=(
    --notebooklm-pack
    --pack-max-bytes "${PACK_MAX_BYTES:-180000000}"
    --pack-reserve-bytes "${PACK_RESERVE_BYTES:-10000000}"
    --pack-separator "${PACK_SEPARATOR:-blank}"
  )
  if [[ -n "${PACK_OUT_DIR:-}" ]]; then
    SCRAPE_ARGS+=(--pack-out-dir "$PACK_OUT_DIR")
  fi
fi

if node src/cli/scrape.js "${SCRAPE_ARGS[@]}"
then
  notify_done "Educative scrape finished" "$COURSE_NAME completed. PM2 stopped."
  cleanup_pm2
else
  exit $?
fi
