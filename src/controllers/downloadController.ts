import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";

import { Request, Response, NextFunction } from "express";

import { DownloadFormat, DownloadResult } from "../types/download";
import { AppError } from "../utils/errors";
import { prepareDownload } from "../services/downloaderService";
import { env } from "../config/env";

function parseFormats(value: unknown): DownloadFormat[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const formats = rawValues.filter((item): item is DownloadFormat => item === "mp3" || item === "mp4");

  if (formats.length === 0) {
    throw new AppError("At least one format must be selected (mp3 or mp4).", 400);
  }

  return Array.from(new Set(formats));
}

function parseYouTubeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("A YouTube URL is required.", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError("Invalid URL format.", 400);
  }

  const host = parsed.hostname.toLowerCase();
  const isYoutube =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");

  if (!isYoutube) {
    throw new AppError("Only YouTube URLs are supported.", 400);
  }

  return parsed.toString();
}

function parseYouTubeUrls(singleValue: unknown, multiValue: unknown): string[] {
  const multiInput = typeof multiValue === "string" ? multiValue : "";
  const singleInput = typeof singleValue === "string" ? singleValue : "";

  const rawItems = multiInput
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (rawItems.length === 0 && singleInput.trim()) {
    rawItems.push(singleInput.trim());
  }

  if (rawItems.length === 0) {
    throw new AppError("At least one YouTube URL is required.", 400);
  }

  if (rawItems.length > 30) {
    throw new AppError("A maximum of 30 URLs is allowed per request.", 400);
  }

  return rawItems.map(parseYouTubeUrl);
}

async function saveCookiesUpload(cookiesBuffer?: Buffer): Promise<{ path?: string; cleanup: () => Promise<void> }> {
  if (!cookiesBuffer) {
    return { cleanup: async () => Promise.resolve() };
  }

  await fs.mkdir(env.tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(env.tempRoot, "cookies-"));
  const cookiePath = path.join(dir, "cookies.txt");
  await fs.writeFile(cookiePath, cookiesBuffer);

  return {
    path: cookiePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

export async function downloadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const urls = parseYouTubeUrls(req.body.url, req.body.urls);
    const formats = parseFormats(req.body.format);

    const cookieFile = await saveCookiesUpload(req.file?.buffer);

    try {
      const preparedResults: DownloadResult[] = [];

      try {
        for (let index = 0; index < urls.length; index += 1) {
          for (const format of formats) {
            const prepared = await prepareDownload({
              url: urls[index],
              format,
              cookiesFilePath: cookieFile.path
            });

            preparedResults.push(prepared);
          }
        }
      } catch (error) {
        await Promise.all(preparedResults.map((item) => item.cleanup()));
        throw error;
      }

      if (preparedResults.length === 1) {
        const prepared = preparedResults[0];
        res.download(prepared.filePath, prepared.downloadName, async (error) => {
          await prepared.cleanup();
          await cookieFile.cleanup();

          if (error && !res.headersSent) {
            next(new AppError("File transfer failed. Please try again.", 500));
          }
        });
        return;
      }

      const archiveName = `youtube-downloads-${Date.now()}.zip`;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename=\"${archiveName}\"`);

      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", async (error) => {
        await Promise.all(preparedResults.map((item) => item.cleanup()));
        await cookieFile.cleanup();
        next(new AppError(error.message || "Failed to build zip archive.", 500));
      });

      res.on("close", async () => {
        await Promise.all(preparedResults.map((item) => item.cleanup()));
        await cookieFile.cleanup();
      });

      archive.pipe(res);
      for (const file of preparedResults) {
        archive.file(file.filePath, { name: file.downloadName });
      }

      await archive.finalize();
    } catch (error) {
      await cookieFile.cleanup();
      throw error;
    }
  } catch (error) {
    next(error);
  }
}

export function healthHandler(_req: Request, res: Response): void {
  res.json({ ok: true });
}
