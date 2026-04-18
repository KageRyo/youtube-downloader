# YouTube Downloader

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-3C873A?logo=node.js&logoColor=white)](https://nodejs.org/)
[![UI Language](https://img.shields.io/badge/UI-English%20%7C%20%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87-orange)](#internationalization)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A lightweight web application for downloading YouTube videos as mp3 or mp4.

This project uses a browser UI plus a Node.js backend that calls `yt-dlp` (and `ffmpeg` for mp3 conversion).

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
3. ffmpeg (required for mp3 output)

Example setup on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

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
| `PORT` | No | `3000` | HTTP server port |
| `DOWNLOADER_TMP_DIR` | No | OS temp directory | Temporary working directory for download jobs |
| `DOWNLOAD_FILE_TTL_MINUTES` | No | `10` | Retention time for completed download artifacts before auto cleanup |
| `YTDLP_COOKIES_FROM_BROWSER` | No | unset | Automatic fallback for YouTube sign-in challenge, e.g. `chrome` or `firefox:default` |

Reference template: `.env.template`

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

- `POST /api/download` creates a background job and returns `202` with a job summary.
- `GET /api/download/:jobId` returns the current job status and real progress.
- `GET /api/download/:jobId/file` streams the finished file when the job is complete.
- `GET /api/download/:jobId/items/:itemId/file` streams one successful item from the job.
- `POST /api/download/:jobId/cancel` cancels an active job or cleans up a completed artifact immediately.
- Single URL + single format: the job produces one file.
- Single URL + multiple formats: the job bundles outputs into one zip.
- Multiple URLs: the job bundles outputs into one zip.
- Completed files expire automatically after the configured TTL and are removed from disk.
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

## Deployment Notes

This project is not a static-only application.

- GitHub Pages alone is not enough (it cannot run `yt-dlp` or `ffmpeg`).
- You need a backend runtime that supports Node.js and system binaries.
- Typical setup: static frontend + deployed backend API (Render, Railway, Fly.io, VPS, etc.).

## Security and Access

- This project does not include any bypass mechanism for restricted content.
- For private/member/age-restricted videos, you must use a valid account with legitimate access.
- Treat `cookies.txt` as sensitive data. Do not commit it, share it publicly, or store it long-term.

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
