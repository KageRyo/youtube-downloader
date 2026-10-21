# YouTube Downloader

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
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
- Temporary files are cleaned up after response

## Tech Stack

- Runtime: Node.js + TypeScript
- Web framework: Express
- Frontend UI: Vanilla HTML/CSS/JS
- Download engine: yt-dlp
- Audio conversion: ffmpeg

## Prerequisites

Install the following tools on your machine:

1. Node.js 18+
2. yt-dlp
3. ffmpeg and ffprobe (required for both formats)

Example setup on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

The app uses a complete executable `ffmpeg`/`ffprobe` pair in `tools/bin/`
(`.exe` on Windows) when present. Otherwise it uses both tools from `PATH`.
An incomplete local pair is ignored, and MP3 dependency checks use the same pair
as yt-dlp. yt-dlp itself can also be placed in `tools/bin/`.

## Quick Start

```bash
npm install
cp .env.template .env
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

Tests replace external downloader processes with deterministic fixtures. They cover
successful and failed downloads, temporary-file cleanup, batch progress, and ZIP
extraction without making requests to YouTube. Cancellation and output validation
regressions are added alongside their fixes.

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

1. `yt-dlp is not available`
Install `yt-dlp` and ensure it is available in `PATH`.

2. `ffmpeg is required for mp3 downloads`
Install `ffmpeg` and retry.

3. `YouTube requested sign-in verification from this server`
This can happen even for public videos (anti-bot challenge). Retry with a valid `cookies.txt` from an authorized account.

How to get `cookies.txt` (recommended):
- Install browser extension `Get cookies.txt LOCALLY`.
- Open `https://www.youtube.com` while logged in.
- Use the extension to export `cookies.txt` in Netscape format.
- Upload that file in the page and retry.

Quick console snippet (debug only, often incomplete because HttpOnly cookies are not accessible):

```js
copy(document.cookie)
```

If this snippet returns only a few fields or fails to work, use the extension method above.

4. Build succeeds but download fails at runtime
Verify `yt-dlp --version` and `ffmpeg -version` on the server host.

## License

This repository is distributed under the [MIT LICENSE](LICENSE).
