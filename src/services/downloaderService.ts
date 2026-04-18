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
    "private video",
    "members-only",
    "age-restricted",
    "this video is unavailable",
    "not available in your country",
    "cookies",
    "authentication"
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

async function ensureDependencies(format: DownloadRequest["format"]): Promise<void> {
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

  const outputTemplate = path.join(tempDir, "%(title).160B.%(ext)s");
  const args = [
    "--no-playlist",
    "--no-progress",
    "--newline",
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath"
  ];

  if (request.cookiesFilePath) {
    args.push("--cookies", request.cookiesFilePath);
  }

  if (request.format === "mp3") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("-f", "bv*+ba/b");
  }

  args.push(request.url);

  const result = await runCommand("yt-dlp", args);
  if (result.code !== 0) {
    await fs.rm(tempDir, { recursive: true, force: true });
    const stderr = result.stderr.trim();

    if (isAccessRestrictedError(stderr)) {
      if (request.cookiesFilePath) {
        throw new AppError(
          "This video requires account access. Make sure cookies.txt is valid and belongs to an authorized account.",
          403
        );
      }

      throw new AppError(
        "This video requires account access. Try once without cookies, then upload cookies.txt if access fails.",
        403
      );
    }

    throw new AppError(stderr || "Download failed. Please verify the URL and your access level.", 400);
  }

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

  return {
    filePath,
    downloadName,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}
