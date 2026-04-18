import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

import { env } from "../config/env";
import { DownloadRequest, DownloadResult } from "../types/download";
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

function getLocalBinDir(): string {
  return path.resolve(process.cwd(), "tools", "bin");
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

async function ensureDependencies(format: DownloadRequest["format"]): Promise<void> {
  logDownload(`checking dependencies for format=${format}`);
  const hasYtDlp = await isCommandAvailable("yt-dlp");
  if (!hasYtDlp) {
    throw new AppError("yt-dlp is not available. Please install it first.", 500);
  }

  if (format === "mp3") {
    const hasFfmpeg = await isCommandAvailable("ffmpeg");
    if (!hasFfmpeg) {
      throw new AppError("ffmpeg is required for mp3 downloads. Please install it first.", 500);
    }
  }
}

export async function prepareDownload(request: DownloadRequest): Promise<DownloadResult> {
  await ensureDependencies(request.format);

  await fs.mkdir(env.tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(env.tempRoot, "job-"));
  logDownload(`starting job url=${request.url} format=${request.format} tempDir=${tempDir}`);

  const outputTemplate = path.join(tempDir, "%(title).160B.%(ext)s");
  const localBinDir = getLocalBinDir();
  const baseArgs = [
    "--no-playlist",
    "--newline",
    "--ffmpeg-location",
    localBinDir,
    "--js-runtimes",
    `node:${process.execPath}`,
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath"
  ];

  if (request.cookiesFilePath) {
    baseArgs.push("--cookies", request.cookiesFilePath);
  }

  if (request.format === "mp3") {
    baseArgs.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    baseArgs.push("-f", "bv*+ba/b");
  }

  baseArgs.push(request.url);

  logDownload(`running yt-dlp with ffmpeg=${localBinDir}`);

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
    logDownload(`heartbeat url=${request.url} format=${request.format} detail=${detail} progress=${lastReportedPercent.toFixed(1)}%`);
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
    progressBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      reportProgressLine(line);
    }
  };

  const runYtDlp = async (args: string[]) =>
    runCommand("yt-dlp", args, {
      emitOutput: true,
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
      logDownload(`retrying with --cookies-from-browser ${browserSpec}`);
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
    logDownload(`job failed url=${request.url} format=${request.format} exitCode=${result.code}`);
    await fs.rm(tempDir, { recursive: true, force: true });
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
      await fs.rm(tempDir, { recursive: true, force: true });
      throw new AppError("No output file was produced. Please try again.", 500);
    }
    filePath = path.join(tempDir, firstFile);
  }

  const downloadName = getDownloadFileName(filePath);
  request.progress?.("completed", downloadName, 100);
  logDownload(`job completed url=${request.url} format=${request.format} file=${downloadName}`);

  return {
    filePath,
    downloadName,
    cleanup: async () => {
      logDownload(`cleaning up tempDir=${tempDir}`);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}
