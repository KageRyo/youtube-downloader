#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep all cleanup scoped to this invocation, including on failed CI runs.
project="youtube-downloader-smoke-${GITHUB_RUN_ID:-$$}-${RANDOM}"
export APP_PORT=0
compose=(docker compose --project-name "$project" --file compose.yaml)
cleanup() { "${compose[@]}" down --remove-orphans; }
trap cleanup EXIT
"${compose[@]}" up --build --detach --wait --wait-timeout 120
# Expand these expressions inside the container.
# shellcheck disable=SC2016
"${compose[@]}" exec -T app sh -eu -c '
  test "$(id -u)" != 0
  test "$(yt-dlp --version)" = 2026.08.19
  node dist/doctor.js
  ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=mono -t 0.1 -c:a libmp3lame /tmp/smoke.mp3
  test "$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 /tmp/smoke.mp3)" = mp3
  rm /tmp/smoke.mp3
  test "$(stat -c %a /tmp)" = 1777
  test "$(df -Pk /tmp | tail -1 | awk "{print \$2}")" = 786432
  if touch /app/should-be-read-only 2>/dev/null; then exit 1; fi
'
"${compose[@]}" exec -T app python3 - <<'PYTHON'
import sys
from importlib.resources import files
sys.path.insert(0, "/usr/local/bin/yt-dlp")
import yt_dlp_ejs
assert files("yt_dlp_ejs.yt.solver").joinpath("core.min.js").read_bytes()
assert files("yt_dlp_ejs.yt.solver").joinpath("lib.min.js").read_bytes()
print("Bundled EJS solver resources are readable.")
PYTHON
endpoint="$("${compose[@]}" port app 3000)"
# Allow only the local published health port and never route it through a proxy.
[[ "$endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]
health="$(curl --noproxy '*' --fail --silent "http://${endpoint}/api/health")" # NOSONAR: Loopback-only public health check sends no sensitive data.
printf '%s' "$health" | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True'
container="$("${compose[@]}" ps -q app)"
"${compose[@]}" stop app
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0 ]]
echo 'Docker smoke passed: health, dependencies, non-root, storage cap, read-only filesystem, graceful shutdown.'
