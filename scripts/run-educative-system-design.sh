#!/bin/zsh
set -euo pipefail

APP_NAME="educative-system-design"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-${CONTENT_ACQUISITION_OUT_DIR:-$HOME/Documents/educative}}"
COURSE_SLUG="system-design"
COURSE_DIR="$OUT_DIR/$COURSE_SLUG"
COMPLETION_FILE="$COURSE_DIR/completion.json"
START_URL="https://www.educative.io/interview-prep/system-design/introduction-to-modern-system-design"

mkdir -p "$COURSE_DIR"
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

on_success() {
  python3 - <<'PY'
import json, os, pathlib, datetime
default_course_dir = pathlib.Path(os.environ.get('CONTENT_ACQUISITION_OUT_DIR', os.path.expanduser('~/Documents/educative'))) / 'system-design'
course_dir = pathlib.Path(os.environ.get('COURSE_DIR', default_course_dir))
manifest_path = course_dir / 'manifest.json'
out_path = course_dir / 'completion.json'
manifest = {}
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text())
out = {
    'completedAt': datetime.datetime.utcnow().isoformat() + 'Z',
    'courseDir': str(course_dir),
    'lessonCount': len(manifest.get('lessons', [])),
    'stopReason': manifest.get('stopReason'),
    'lastCompletedLessonKey': manifest.get('lastCompletedLessonKey'),
}
out_path.write_text(json.dumps(out, indent=2))
print(json.dumps(out))
PY
  notify_done "Educative scrape finished" "System Design course completed. PM2 stopped."
  cleanup_pm2
}

export COURSE_DIR
if node src/cli/scrape.js \
  --provider educative \
  --url "$START_URL" \
  --out-dir "$OUT_DIR" \
  --min-delay-ms 60000 \
  --max-delay-ms 180000
then
  on_success
else
  exit $?
fi
