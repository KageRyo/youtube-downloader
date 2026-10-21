# YouTube Downloader

Current release: **[v1.1.0](https://github.com/KageRyo/youtube-downloader/releases/tag/v1.1.0)**

[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![UI Language](https://img.shields.io/badge/UI-English%20%7C%20%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-orange)](#internationalization)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A lightweight web application for downloading YouTube videos as mp3 or mp4.

This project uses a browser UI plus a Node.js backend that calls `yt-dlp` (with `ffmpeg` and `ffprobe` for conversion, merging and verification).

## Features

- Download format selection: mp3 or mp4
- Batch download support (multiple URLs in one request)
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
3. ffmpeg and ffprobe (required for both formats)

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
An incomplete local pair is ignored, and both-format dependency checks use the same pair
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
- `format` (required): one or both of `mp3`, `mp4` (repeat field for multiple selections)
- `videoResolution` / `audioBitrate` (optional): quality presets above
- `items` (optional): JSON array of exact `{url, format}` pairs for retry; when supplied, it replaces the URL/format cross-product (up to 60 items and 30 unique URLs)
- `cookiesFile` (optional): `cookies.txt` for authenticated access

Behavior:

- `POST /api/download` accepts a running or queued job and returns `202` with its summary.
- Queue, retained-record or storage capacity returns `503` with `Retry-After: 60`.
- The creation rate limit returns `429` with `Retry-After`; polling and file downloads remain available.
- `GET /api/download/:jobId` returns the current job status and real progress.
- `GET /api/download/:jobId/file` streams the finished file when the job is complete.
- `GET /api/download/:jobId/items/:itemId/file` streams one successful item from the job.
- `POST /api/download/:jobId/cancel` cancels queued/running work. Cancellation is terminal, skips remaining items and removes partial artifacts after process termination; completed artifacts remain available until TTL.
- Single URL + single format: the job produces one file.
- Single URL + multiple formats: the job bundles outputs into one zip.
- Multiple URLs: the job bundles outputs into one zip.
- Completed files expire automatically after the configured TTL and are removed from disk.
- Cancellation waits for the downloader process to close before file cleanup. Linux/macOS signal the process group and escalate after 1.5 seconds; Windows terminates the process tree with `taskkill /T /F`.
- The web client auto-sends job cancellation when the page is closed or navigated away.
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
waits for termination and removes retained artifacts. A hard crash can leave
orphaned directories (tracked separately in #9); clean them only when no process
owns that temp root.

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
