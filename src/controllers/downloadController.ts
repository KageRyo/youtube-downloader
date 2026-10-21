import fs from "node:fs/promises";
import path from "node:path";

import { NextFunction, Request, Response } from "express";

import { cancelDownloadJob, createDownloadJob, getDownloadJob, getDownloadJobFile, getDownloadJobItemFile } from "../services/downloadJobService";
import { DownloadFormat } from "../types/download";
import { env } from "../config/env";
import { parseDownloadOptions, parseSelections, parseYouTubeUrl } from "../utils/downloadOptions";
import { AppError } from "../utils/errors";
import { createOwnedTempDirectory } from "../services/tempDirectoryService";

function parseFormats(value: unknown): DownloadFormat[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const formats = rawValues.filter((item): item is DownloadFormat => item === "mp3" || item === "mp4");

  if (formats.length === 0) {
    throw new AppError("At least one format must be selected (mp3 or mp4).", 400);
  }

  return Array.from(new Set(formats));
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

function getJobIdParam(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  throw new AppError("Download job not found.", 404);
}

async function saveCookiesUpload(cookiesBuffer?: Buffer): Promise<{ path?: string; cleanup: () => Promise<void> }> {
  if (!cookiesBuffer) {
    return { cleanup: async () => Promise.resolve() };
  }

  const dir = await createOwnedTempDirectory(env.tempRoot, "cookies");
  const cookiePath = path.join(dir, "cookies.txt");
  try {
    await fs.writeFile(cookiePath, cookiesBuffer, { mode: 0o600 });
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: cookiePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

export async function createJobHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const items = parseSelections(req.body.items);
    const urls = items ? [...new Set(items.map((item) => item.url))] : parseYouTubeUrls(req.body.url, req.body.urls);
    const formats = items ? [...new Set(items.map((item) => item.format))] : parseFormats(req.body.format);
    const options = parseDownloadOptions(req.body);
    const cookieFile = await saveCookiesUpload(req.file?.buffer);

    try {
      const job = createDownloadJob({
        urls,
        formats,
        items,
        ...options,
        cookiesFilePath: cookieFile.path
      });

      res.status(202).json(job);
    } catch (error) {
      await cookieFile.cleanup();
      throw error;
    }
  } catch (error) {
    next(error);
  }
}

export function getJobStatusHandler(req: Request, res: Response, next: NextFunction): void {
  try {
    const job = getDownloadJob(getJobIdParam(req.params.jobId));
    res.json(job);
  } catch (error) {
    next(error);
  }
}

export async function getJobFileHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const jobFile = await getDownloadJobFile(getJobIdParam(req.params.jobId));
    res.download(jobFile.filePath, jobFile.downloadName, (error) => {
      if (error && !res.headersSent) {
        next(new AppError("File transfer failed. Please try again.", 500));
      }
    });
  } catch (error) {
    next(error);
  }
}

export function getJobItemFileHandler(req: Request, res: Response, next: NextFunction): void {
  try {
    const jobFile = getDownloadJobItemFile(getJobIdParam(req.params.jobId), getJobIdParam(req.params.itemId));
    res.download(jobFile.filePath, jobFile.downloadName, (error) => {
      if (error && !res.headersSent) {
        next(new AppError("File transfer failed. Please try again.", 500));
      }
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelJobHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await cancelDownloadJob(getJobIdParam(req.params.jobId));
    res.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
}

export function healthHandler(_req: Request, res: Response): void {
  res.json({ ok: true });
}
