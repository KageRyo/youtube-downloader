# YouTube Downloader

Current release: **[v1.1.0](https://github.com/KageRyo/youtube-downloader/releases/tag/v1.1.0)**

[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![UI Language](https://img.shields.io/badge/UI-English%20%7C%20%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-orange)](#internationalization)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A lightweight web application for downloading YouTube media as MP3/MP4 and captions as SRT/VTT.

This project uses a browser UI plus a Node.js backend that calls `yt-dlp` (with `ffmpeg` and `ffprobe` for conversion, merging and verification).

## Features

- Download media as MP3/MP4 or captions as SRT/VTT
- Select MP4 resolution and MP3 bitrate, and preview video metadata
- Batch downloads with per-item status, cancellation and failed-item retry
- Restore active tasks after reloading the same browser tab
- Docker Compose deployment with bounded resources and localhost defaults
- Clean custom web frontend (no UI framework dependency)
- No database required
- Optional `cookies.txt` upload for videos that require authenticated access
- Completed files remain available until TTL; cancelled/failed work is cleaned after termination

## Tech Stack

- Runtime: Node.js + TypeScript
- Web framework: Express
- Frontend UI: Vanilla HTML/CSS/JS
- Download engine: yt-dlp
- Audio conversion: ffmpeg

## Prerequisites

Install the following tools on your machine:

1. Node.js 22+ (Node.js 22 and 24 are tested; `.nvmrc` selects 22)
2. Current yt-dlp with EJS challenge scripts (verified with `2026.08.19`)
3. ffmpeg and ffprobe (media processing, verification and caption conversion)

Example setup on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg python3
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

Install Node.js 22 or 24 before running the app. The Unix `yt-dlp` executable
above needs Python 3.10+; the official standalone platform executables bundle
Python. The app explicitly uses its own Node binary for yt-dlp's JS runtime.
Official yt-dlp executables bundle EJS. If installing with pip/pipx, use the
`default` dependency group (`pipx install "yt-dlp[default]"`) so the matching
`yt-dlp-ejs` package is installed. Third-party packages may omit it.
See the [upstream EJS installation guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
Keep yt-dlp/EJS current when YouTube changes its challenges.

The app uses a complete executable `ffmpeg`/`ffprobe` pair in `tools/bin/`
(`.exe` on Windows) when present. Otherwise it uses both tools from `PATH`.
An incomplete local pair is ignored, and dependency checks use the same pair
as yt-dlp. yt-dlp itself can also be placed in `tools/bin/`.

## Quick Start

```bash
npm ci --ignore-scripts
cp .env.template .env
npm run build
npm run doctor
npm run dev
```

Open: http://localhost:3000

## Configuration

Environment variables are loaded from `.env`.

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `HOST` | No | `127.0.0.1` | Bind address; public binding is opt-in |
| `PORT` | No | `3000` | HTTP server port |
| `DOWNLOADER_TMP_DIR` | No | OS temp directory | Temporary working directory for download jobs |
| `DOWNLOAD_FILE_TTL_MINUTES` | No | `10` | Retention time for completed download artifacts before auto cleanup |
| `ORPHAN_TEMP_MAX_AGE_MS` | No | `86400000` | Minimum age in milliseconds for startup recovery of abandoned owned directories |
| `MAX_CONCURRENT_JOBS` | No | `2` | Running jobs per server process |
| `MAX_QUEUED_JOBS` | No | `8` | Waiting jobs in addition to running jobs |
| `MAX_RETAINED_JOBS` | No | `32` | Maximum total job records, including terminal records |
| `MAX_JOB_BYTES` | No | `536870912` | Per-job working files and ZIP size budget (512 MiB) |
| `MAX_STORAGE_BYTES` | No | `8589934592` | Storage reservations across accepted jobs (8 GiB) |
| `JOB_TIMEOUT_MS` | No | `1800000` | Running time budget, including packaging (30 minutes) |
| `CREATION_RATE_LIMIT` | No | `10` | Download submissions per client per minute |
| `YTDLP_COOKIES_FROM_BROWSER` | No | unset | Automatic fallback for YouTube sign-in challenge, e.g. `chrome` or `firefox:default` |

Reference template: `.env.template`

## Output formats

MP4 downloads prefer H.264/AAC streams, merge into MP4 and remux single-stream
fallbacks into MP4. The final extension, container brand and video stream are
verified with ffprobe. If the source codecs cannot be remuxed, the item fails
with an error; the app does not silently return WebM/MKV or spend CPU transcoding.
The best available resolution may use codecs unsupported by older players.
MP3 keeps its existing highest-quality VBR conversion policy.

### Quality selection

`videoResolution` accepts `480`, `720`, `1080` or `2160` as a maximum height.
The best source at or below the cap is selected, with no upscaling; a source with
no matching format fails instead of exceeding the cap. MP4 codecs/container are
still verified. `audioBitrate` accepts `128`, `192`, `256` or `320` kbps for MP3.
Omitting either field (or selecting `best`) preserves previous defaults. A higher
resolution or bitrate generally increases size and conversion cost; bitrate alone
does not improve a low-quality source.

### Video preview

Use **Preview videos** before downloading, or `POST /api/preview` with JSON
`{"urls":["https://youtu.be/..."]}`. Up to 30 URLs are handled sequentially;
only two preview requests run per process, each with a 60-second batch budget
and 15-second per-video budget. The response exposes only the submitted URL,
title, optional duration and approved YouTube thumbnail, or a per-item error.
Preview never starts a media download, writes an artifact or uses uploaded/browser
cookies. Private/unavailable videos may therefore fail preview even if an
authenticated download is possible. Thumbnail requests use HTTPS YouTube image
hosts with query credentials removed and no referrer; other hosts are omitted.

### Subtitle downloads

Select SRT and/or VTT with exact language tags such as `en,zh-Hant` (up to 5),
and choose **manual** or **automatic** captions. The corresponding API fields are
`subtitleLanguages` (comma-separated tags) and `subtitleSource` (`manual` by
default, or `automatic`). Select only subtitle formats to skip media downloads;
select media formats too to package both kinds in the same collision-safe ZIP.

Each URL/format/language combination is a separate item (maximum 60 total).
Missing languages or unavailable caption sources yield explicit item failures,
never empty invented subtitle files or automatic fallback to another source.
Successful languages remain downloadable alongside the failed-item report.
Failed-caption retries retain the exact language and source. SRT/VTT conversion
uses FFmpeg; produced files must have recognizable caption headers/cues. Caption
quality depends on the source, especially for automatic captions.

## Internationalization

- Default UI language: English
- Supported UI languages: English, Traditional Chinese
- Language selection is stored in browser local storage

## Project Structure

```text
public/
  app.js                # Frontend form submission and file download handling
  index.html            # UI markup
  style.css             # UI styles

src/
  app.ts                # Express app setup and global error handler
  server.ts             # HTTP server entrypoint
  config/
    env.ts              # Environment config
  controllers/
    downloadController.ts
  routes/
    downloadRoutes.ts
  services/
    downloaderService.ts
  types/
    download.ts
  utils/
    errors.ts
    files.ts
    process.ts
```

## API

### Health Check

- Method: `GET`
- Path: `/api/health`
- Response: `{"ok": true}`

### Download

- Method: `POST`
- Path: `/api/download`
- Content-Type: `multipart/form-data`

Form fields:

- `urls` (required): one or more YouTube URLs, one per line
- `format` (required): one or more of `mp3`, `mp4`, `srt`, `vtt` (repeat field for multiple selections)
- `videoResolution` / `audioBitrate` (optional): quality presets above
- `subtitleLanguages` / `subtitleSource` (optional): caption options above
- `items` (optional): JSON array of exact `{url, format, subtitleLanguage?, subtitleSource?}` items for retry; when supplied, it replaces the URL/format cross-product (up to 60 items and 30 unique URLs)
- `cookiesFile` (optional): `cookies.txt` for authenticated access

Behavior:

- `POST /api/download` accepts a running or queued job and returns `202` with its summary.
- Queue, retained-record or storage capacity returns `503` with `Retry-After: 60`.
- The creation rate limit returns `429` with `Retry-After`; polling and file downloads remain available.
- `GET /api/download/:jobId` returns the current job status and real progress.
- `GET /api/download/:jobId/file` streams the finished file when the job is complete.
- `GET /api/download/:jobId/items/:itemId/file` streams one successful item from the job.
- `POST /api/download/:jobId/cancel` cancels queued/running work. Cancellation is terminal, skips remaining items and removes partial artifacts after process termination; completed artifacts remain available until TTL.
- One output item: the job produces one file.
- Multiple output items (URLs, formats or subtitle languages): the job bundles successful outputs into one ZIP with a report of any failed items.
- Completed files expire automatically after the configured TTL and are removed from disk.
- Cancellation waits for the downloader process to close before file cleanup. Linux/macOS signal the process group and escalate after 1.5 seconds; Windows terminates the process tree with `taskkill /T /F`.
- The web task panel shows every item status, error, and available download. Use **Cancel** to stop a queued/running job. Closing or reloading the page keeps server work running; the same tab recovers jobs from sessionStorage until the server TTL expires. Only opaque job UUIDs are saved, never URLs, titles, cookies, or settings.
- **Retry failed items** creates a new job with only failed output items, keeping successful downloads intact. During the same page session it preserves the original submission settings and cookies file in memory. After reload, choose settings and reselect cookies.txt in the form before retrying. The multipart `items` field accepts exact URL/format items; captions also carry their original `subtitleLanguage` and `subtitleSource`.
- 網頁任務面板提供逐項狀態、錯誤、下載、取消與失敗項目重試。關閉或重新載入網頁不會取消伺服器任務；同一分頁會在 TTL 期限內恢復查詢。僅保存任務 UUID，不保存網址、標題、cookies 或設定。重新載入後，重試使用目前表單設定，請視需要重新選取 cookies.txt。
- If no authentication is required, cookies are not needed.
- If access is restricted, provide a valid `cookies.txt` from an account that has legal access.
- If configured, the server will automatically retry with `--cookies-from-browser` when YouTube asks for sign-in verification.

## Scripts

```bash
npm run dev       # Start development server (tsx watch)
npm run build     # Compile TypeScript to dist/
npm run start     # Run compiled server
npm run doctor    # Offline dependency/storage checks (run build first)
npm run typecheck # Type-check only
npm test          # Run tests in tests/
```

## Validation

Use Node.js 22 or 24 (CI checks both on Linux and Windows). `.nvmrc` selects Node.js 22.
Run the same checks locally:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Tests use deterministic fixtures for external downloader behavior and real local
processes for cancellation-tree checks. They cover cleanup, output/container
validation, ZIP extraction, cancellation races, overload, storage/time budgets
and rate limits without making requests to YouTube.

## Deployment Notes

This project is not a static-only application.

- GitHub Pages alone is not enough (it cannot run `yt-dlp` or `ffmpeg`).
- You need a backend runtime that supports Node.js and system binaries.
- Typical setup: static frontend + deployed backend API (Render, Railway, Fly.io, VPS, etc.).

The server binds to localhost by default. Set `HOST=0.0.0.0` only when external
access is intended. Limits apply per server process; use one process per dedicated
temp root. Each accepted job reserves `MAX_JOB_BYTES` until its files are cleaned,
including completed files waiting for TTL. Cancelled/failed jobs release their
reservation after cleanup; cleanup failures retain it and retry after TTL.

The byte budget includes original media and the ZIP copy. It is checked after
items/packaging and once per second while running; yt-dlp also receives
`--max-filesize` for known source sizes. Unknown sizes and bytes written between
checks can temporarily exceed the budget. Cookies are limited to 2 MiB per job.
Use a dedicated filesystem quota/container storage limit for a hard disk cap,
and OS/container CPU and memory limits for public deployments.

The rate limiter uses the socket client address and ignores forwarded headers.
Behind a reverse proxy, clients share the proxy's limit; configure per-user/IP
rate limits and authentication at that proxy. In-memory limits do not coordinate
multiple instances. SIGINT/SIGTERM stops admission, aborts queued/running work,
waits for termination and removes retained artifacts.

Jobs exist only in memory: after a restart, old job IDs return 404 and downloads
do not resume. Before listening, the server checks for abandoned `job-<UUID>`
and `cookies-<UUID>` directories in its temp root. New directories contain a
private `.youtube-downloader-owner.json` marker with the creator PID, creation
time and Linux boot/PID namespace identity. Nested item directories belong to
their job and are removed with it. Uploaded cookies follow the same recovery
rules as media artifacts.

Startup recovery removes a directory only when its marker, creation time and
directory modification time are older than `ORPHAN_TEMP_MAX_AGE_MS` (24 hours
by default), its ownership identity matches the current Linux boot and PID
namespace, and its creator PID no longer exists. A live or reused PID always
preserves the directory, regardless of age. Recovery never follows directory or
marker symlinks, guesses ownership of legacy unmarked directories, or removes
unrelated paths. Fresh abandoned files wait for a later restart; collection is
not periodic and does not restore the previous process's storage reservations.

On other platforms, after a host reboot or PID namespace change, or when process
identity cannot be verified, automatic recovery conservatively retains files.
Review those leftovers manually only after confirming all processes using that
temp root have stopped. Keep the root private and dedicated to this application;
startup recovery does not replace a filesystem quota or coordination between
server instances.

## Docker Compose

Requires Docker Engine with the Compose plugin (Docker Desktop with WSL integration
on Windows). From this checkout:

```bash
docker compose up --build --detach --wait
docker compose exec app node dist/doctor.js
curl --fail http://127.0.0.1:3000/api/health
docker compose down
```

Open <http://127.0.0.1:3000>. Set `export APP_PORT=3001` before the commands to change
the host port. Compose binds the published port to localhost; the process listens
on `0.0.0.0` inside its container. The healthcheck verifies the HTTP service;
`doctor` separately verifies executable tools and temporary storage. Neither
check confirms current YouTube access. Run `./scripts/docker-smoke.sh` for the
same isolated build/runtime/shutdown check used by Docker CI.

The multi-stage image pins the Node 22 base by manifest digest, npm dependencies
by `package-lock.json`, and official yt-dlp `2026.08.19` by SHA-256 (including its
matching EJS solver). FFmpeg, ffprobe and Python come from the dated Debian
snapshot in `Dockerfile`. Refresh the digest, snapshot and yt-dlp version/hash
together as needed for security fixes and YouTube compatibility, then rebuild
and rerun the smoke check. These pins make inputs traceable; they do not promise
bit-for-bit identical image output across architectures or build tools.

The runtime runs as the `node` user with a read-only root filesystem, dropped
capabilities, no new privileges, 2 CPUs, 2 GiB memory and 128 PIDs. Downloads,
uploaded cookies and tool caches use a 768 MiB `/tmp` tmpfs with mode `1777` and disappear when the container is removed. There are no host
bind mounts or persistent volumes. The example allows one running job and
reserves up to 512 MiB total, with 128 MiB per job including media **and its ZIP
copy**. The remaining tmpfs space covers upload/intermediate-file overhead and
bytes written between application checks. A hard tmpfs limit can fail a job
before the application reports its own budget error. tmpfs pages consume the
container's memory allowance, so raising storage limits also needs memory
headroom for Node and FFmpeg. Adjust all limits together for larger videos.

This example is intended for local use. Before publishing it beyond localhost,
put authentication, HTTPS and request limits at a reverse proxy and review the
security notes below. Compose forwards SIGTERM and allows 30 seconds for cleanup;
forced termination can interrupt work. Each container has its own temporary
storage; jobs cannot move between instances.

## Security and Access

- This project does not include any bypass mechanism for restricted content.
- For private/member/age-restricted videos, you must use a valid account with legitimate access.
- Treat `cookies.txt` as sensitive data. Do not commit it, share it publicly, or store it long-term.

Process capture retains only the last 64 KiB per stdout/stderr stream while
progress is processed continuously. Unterminated progress lines are bounded too.
Server logs include job IDs, formats, stages and exit codes; they omit input URLs,
cookie paths/browser profiles and raw yt-dlp output. Error responses and a job's
`failed-list.txt` still contain diagnostics for that request; treat job links as
private and protect the API when exposing the service.

## Troubleshooting

Start with `npm run build && npm run doctor`. It exits nonzero for missing tools,
unsupported Node.js, obsolete yt-dlp flags or unwritable/insufficient temporary
storage. It uses the same local-pair/PATH resolution as downloads and makes no
requests to YouTube. A successful check does not prove current account access
or challenge compatibility.

- **Node.js below 22:** switch to 22 or 24, then rerun `npm ci --ignore-scripts`.
- **yt-dlp missing or flags unrecognized:** update the actual binary reported by
  `doctor`; a stale `tools/bin/yt-dlp` takes precedence over PATH.
- **FFmpeg/ffprobe missing:** install both binaries, then rerun `doctor`. If only
  one exists under `tools/bin/`, the app uses the PATH pair instead.
- **EJS/challenge errors:** use an up-to-date official executable or reinstall
  `yt-dlp[default]` including its matching solver package. Check the upstream
  EJS guide before changing cookies.
- **Sign-in verification:** provide Netscape-format `cookies.txt` exported from
  your authorized account, or configure `YTDLP_COOKIES_FROM_BROWSER`. A browser's
  `document.cookie` value is not a Netscape cookies file and misses HttpOnly data.
- **MP4 verification/remux failure:** update FFmpeg/ffprobe and try another source
  or MP3. Unsupported codecs produce an item failure; the app does not recode.
- **429/503:** honor `Retry-After`; wait for jobs or retained artifacts to expire.
  Review configured budgets before increasing concurrency or storage limits.

## Verification checklist

1. `node --version` is 22+ and matches the intended host runtime.
2. `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, `npm test` pass.
3. `npm run doctor` reports executable yt-dlp/FFmpeg/ffprobe and writable storage.
4. `npm start` serves `GET /api/health` at `http://127.0.0.1:3000` with `{"ok":true}`.
5. Check one authorized download on the target host to confirm current YouTube
   access; automated tests intentionally do not depend on YouTube availability.

## License

This repository is distributed under the [MIT LICENSE](LICENSE).
