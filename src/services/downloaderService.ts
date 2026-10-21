import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

import { env } from "../config/env";
import { DownloadRequest, DownloadResult } from "../types/download";
import { getFfmpegLocation } from "../utils/ffmpeg";
import { AppError } from "../utils/errors";
import { sanitizeFileName } from "../utils/files";
import { isCommandAvailable, runCommand } from "../utils/process";

function isAccessRestrictedError(message: string): boolean {
  const normalized = message.toLowerCase();
  const markers = [
    "login required",
    "sign in",
    "sign in to confirm you’re not a bot",
    "sign in to confirm you're not a bot",
    "use --cookies-from-browser or --cookies",
    "private video",
    "members-only",
    "age-restricted",
    "this video is unavailable",
    "not available in your country"
  ];

  return markers.some((marker) => normalized.includes(marker));
}

function pickProducedFilePath(stdout: string): string | null {
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const item of candidates) {
    if (existsSync(item)) {
      return item;
    }
  }

  return null;
}

function getDownloadFileName(filePath: string): string {
  return sanitizeFileName(path.basename(filePath));
}

function logDownload(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[download ${timestamp}] ${message}`);
}

function extractProgressPercent(chunk: string): number | null {
  const matches = chunk.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const lastMatch = matches[matches.length - 1];
  const percent = Number(lastMatch.replace(/[^\d.]/g, ""));

  if (!Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, percent));
}

async function ensureDependencies(format: DownloadRequest["format"], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  logDownload(`checking dependencies for format=${format}`);
  const hasYtDlp = await isCommandAvailable("yt-dlp", { signal });
  signal?.throwIfAborted();
  if (!hasYtDlp) {
    throw new AppError("yt-dlp is not available. Please install it first.", 500);
  }

  const location = getFfmpegLocation();
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const executable = location ? path.join(location, `${tool}${process.platform === "win32" ? ".exe" : ""}`) : tool;
    if (!await isCommandAvailable(executable, { preferLocal: false, signal })) {
      signal?.throwIfAborted();
      throw new AppError(`${tool} is required for ${format} downloads. Install both ffmpeg and ffprobe in PATH or tools/bin.`, 500);
    }
  }
  return location;
}

export async function prepareDownload(request: DownloadRequest): Promise<DownloadResult> {
  const ffmpegLocation = await ensureDependencies(request.format, request.signal);

  const tempRoot = request.tempRoot ?? env.tempRoot;
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "item-"));
  try {
    logDownload(`starting job format=${request.format}`);

    const outputTemplate = path.join(tempDir, "%(title).160B.%(ext)s");
    const baseArgs = [
      "--no-playlist",
      "--newline",
      "--js-runtimes",
      `node:${process.execPath}`,
      "-o",
      outputTemplate,
      "--print",
      "after_move:filepath"
    ];

    if (request.maxBytes) baseArgs.push("--max-filesize", String(request.maxBytes));

    if (ffmpegLocation) {
      baseArgs.push("--ffmpeg-location", ffmpegLocation);
    }

    if (request.cookiesFilePath) {
      baseArgs.push("--cookies", request.cookiesFilePath);
    }

    if (request.format === "mp3") {
      baseArgs.push("-x", "--audio-format", "mp3", "--audio-quality", request.audioBitrate ? `${request.audioBitrate}K` : "0");
    } else {
      baseArgs.push("-f", request.videoResolution ? `bv*[height<=${request.videoResolution}]+ba/b[height<=${request.videoResolution}]` : "bv*+ba/b", "--merge-output-format", "mp4", "--remux-video", "mp4", "-S", "vcodec:h264,acodec:aac");
    }

    baseArgs.push(request.url);

    logDownload(`running yt-dlp with ffmpeg=${ffmpegLocation ? "local" : "PATH"}`);

    request.progress?.("running", "starting yt-dlp", 10);

    let lastReportedPercent = 10;
    let sawProgressLine = false;
    let progressBuffer = "";

    const heartbeat = setInterval(() => {
      if (!request.progress) {
        return;
      }

      const detail = sawProgressLine ? "downloading media" : "resolving metadata and formats";
      console.log(`[HEARTBEAT] ${lastReportedPercent.toFixed(1)}% - ${detail}`);
      logDownload(`heartbeat format=${request.format} stage=${detail} progress=${lastReportedPercent.toFixed(1)}%`);
      request.progress("running", detail, lastReportedPercent);
    }, 1500);

    const reportProgressLine = (line: string): void => {
      const percent = extractProgressPercent(line);
      if (percent === null || !request.progress) {
        return;
      }

      sawProgressLine = true;
      const normalizedPercent = Math.max(lastReportedPercent, Math.min(95, percent));
      if (normalizedPercent <= lastReportedPercent) {
        return;
      }

      lastReportedPercent = normalizedPercent;
      console.log(`[yt-dlp 進度] ${normalizedPercent}%`);
      request.progress("running", "downloading", normalizedPercent);
    };

    const consumeProgressChunk = (chunk: string): void => {
      progressBuffer += chunk.replace(/\r/g, "\n");
      const lines = progressBuffer.split("\n");
      progressBuffer = (lines.pop() ?? "").slice(-8192);

      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        reportProgressLine(line);
      }
    };

    const runYtDlp = async (args: string[]) =>
      runCommand("yt-dlp", args, {
        emitOutput: false,
        logPrefix: "yt-dlp",
        onStdout: consumeProgressChunk,
        onStderr: consumeProgressChunk,
        signal: request.signal
      });

    let result;
    try {
      result = await runYtDlp(baseArgs);

      const shouldRetryWithBrowserCookies =
        result.code !== 0 &&
        !request.cookiesFilePath &&
        !!env.ytDlpCookiesFromBrowser &&
        isAccessRestrictedError(result.stderr.trim());

      if (shouldRetryWithBrowserCookies) {
        const browserSpec = env.ytDlpCookiesFromBrowser as string;
        logDownload("retrying with configured browser cookies");
        request.progress?.("running", "retrying with browser cookies", Math.max(lastReportedPercent, 15));
        result = await runYtDlp(["--cookies-from-browser", browserSpec, ...baseArgs]);
      }
    } finally {
      clearInterval(heartbeat);
    }

    if (progressBuffer.trim().length > 0) {
      reportProgressLine(progressBuffer.trim());
    }

    if (result.code !== 0) {
      logDownload(`job failed format=${request.format} exitCode=${result.code}`);
      const stderr = result.stderr.trim();

      if (isAccessRestrictedError(stderr)) {
        if (request.cookiesFilePath) {
          throw new AppError(
            "YouTube requested sign-in verification from this server. Make sure cookies.txt is valid, exported in Netscape format, and belongs to an authorized account.",
            403
          );
        }

        if (env.ytDlpCookiesFromBrowser) {
          throw new AppError(
            "YouTube requested sign-in verification, and browser-cookie fallback also failed. Check YTDLP_COOKIES_FROM_BROWSER, browser login state, and profile permissions.",
            403
          );
        }

        throw new AppError(
          "YouTube requested sign-in verification from this server (this can happen even for public videos). Upload cookies.txt, or configure YTDLP_COOKIES_FROM_BROWSER.",
          403
        );
      }

      throw new AppError(stderr || "Download failed. Please verify the URL and your access level.", 400);
    }

    request.progress?.("processing", "finalizing output", Math.max(lastReportedPercent, 90));

    let filePath = pickProducedFilePath(result.stdout);
    if (!filePath) {
      const files = await fs.readdir(tempDir);
      const firstFile = files.at(0);
      if (!firstFile) {
        throw new AppError("No output file was produced. Please try again.", 500);
      }
      filePath = path.join(tempDir, firstFile);
    }

    const actualPath = await fs.realpath(filePath);
    const directory = await fs.realpath(tempDir);
    const relative = path.relative(directory, actualPath);
    const outputStat = await fs.stat(actualPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !outputStat.isFile() || outputStat.size === 0) {
      throw new AppError("The downloader did not produce a valid media file in its working directory.", 500);
    }
    if (request.format === "mp4") {
      if (path.extname(filePath).toLowerCase() !== ".mp4") {
        throw new AppError("MP4 output was not produced. The source may not support MP4 remuxing without recoding.", 400);
      }
      const probePath = ffmpegLocation ? path.join(ffmpegLocation, `ffprobe${process.platform === "win32" ? ".exe" : ""}`) : "ffprobe";
      const probe = await runCommand(probePath, ["-v", "error", "-show_entries", "format=format_name:format_tags=major_brand:stream=codec_type", "-of", "json", actualPath], {
        signal: request.signal, preferLocal: false
      });
      let valid = false;
      try {
        const metadata = JSON.parse(probe.stdout);
        valid = probe.code === 0 && metadata.format?.format_name?.split(",").includes("mp4") &&
          /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V|MSNV|cmf[cs]|av01)$/.test(metadata.format?.tags?.major_brand?.trim() ?? "") &&
          metadata.streams?.some((stream: { codec_type?: string }) => stream.codec_type === "video");
      } catch { /* Invalid probe output is rejected below. */ }
      if (!valid) throw new AppError("MP4 container verification failed. The source could not be delivered as a valid MP4 video without recoding.", 400);
    }
    const downloadName = getDownloadFileName(filePath);
    request.progress?.("completed", downloadName, 100);
    logDownload(`job completed format=${request.format}`);

    return {
      filePath,
      downloadName,
      cleanup: async () => {
        logDownload("cleaning up item artifacts");
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
