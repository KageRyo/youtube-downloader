import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";

import { DownloadFormat, DownloadJobSummary, DownloadResult } from "../types/download";
import { AppError } from "../utils/errors";
import { env } from "../config/env";
import { prepareDownload } from "./downloaderService";

interface JobInput {
  urls: string[];
  formats: DownloadFormat[];
  cookiesFilePath?: string;
}

interface InternalJob extends DownloadJobSummary {
  cookiesFilePath?: string;
  filePath?: string;
  outputDir: string;
  urls: string[];
  formats: DownloadFormat[];
  cleanupPaths: Array<() => Promise<void>>;
  abortController: AbortController;
  cleanupTimer?: NodeJS.Timeout;
  cleanedUp?: boolean;
}

const jobs = new Map<string, InternalJob>();

function logJob(jobId: string, message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[job ${jobId} ${timestamp}] ${message}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createProgressMessage(current: number, total: number, stage: string, detail?: string): string {
  const base = `${stage} (${current}/${total})`;
  return detail ? `${base}: ${detail}` : base;
}

function normalizePercent(current: number, total: number, stageProgress = 0): number {
  if (total <= 0) {
    return 0;
  }

  const itemProgress = Math.min(Math.max(stageProgress, 0), 100) / 100;
  const overall = ((current - 1) + itemProgress) / total;
  return Math.max(0, Math.min(100, Math.round(overall * 1000) / 10));
}

function updateJob(
  job: InternalJob,
  patch: Partial<Pick<InternalJob, "status" | "message" | "error" | "downloadName" | "filePath" | "expiresAt">> & {
    progress?: Partial<InternalJob["progress"]>;
  }
): void {
  const previousStatus = job.status;
  const previousStage = job.progress.stage;
  const previousItemPercent = job.progress.itemPercent;

  if (patch.status) {
    job.status = patch.status;
  }

  if (patch.message !== undefined) {
    job.message = patch.message;
  }

  if (patch.error !== undefined) {
    job.error = patch.error;
  }

  if (patch.downloadName !== undefined) {
    job.downloadName = patch.downloadName;
  }

  if (patch.filePath !== undefined) {
    job.filePath = patch.filePath;
  }

  if (patch.expiresAt !== undefined) {
    job.expiresAt = patch.expiresAt;
  }

  if (patch.progress) {
    job.progress = {
      ...job.progress,
      ...patch.progress
    };
  }

  job.updatedAt = nowIso();

  const previousBucket = Math.floor(previousItemPercent / 10);
  const nextBucket = Math.floor(job.progress.itemPercent / 10);
  const stageChanged = previousStage !== job.progress.stage;
  const statusChanged = previousStatus !== job.status;
  const bucketChanged = previousBucket !== nextBucket;

  if (statusChanged || stageChanged || bucketChanged || patch.error) {
    const detail = job.progress.detail ? ` detail=${job.progress.detail}` : "";
    logJob(
      job.id,
      `status=${job.status} stage=${job.progress.stage} item=${job.progress.itemPercent.toFixed(1)}% total=${job.progress.percent.toFixed(1)}% current=${job.progress.current}/${job.progress.total}${detail}`
    );
  }
}

async function cleanupJobArtifacts(job: InternalJob): Promise<void> {
  if (job.cleanedUp) {
    return;
  }
  job.cleanedUp = true;

  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = undefined;
  }

  for (const cleanup of job.cleanupPaths) {
    await cleanup();
  }

  if (job.cookiesFilePath) {
    const cookieDir = path.dirname(job.cookiesFilePath);
    await fsPromises.rm(cookieDir, { recursive: true, force: true });
  }

  await fsPromises.rm(job.outputDir, { recursive: true, force: true });
}

async function cleanupAndDeleteJob(job: InternalJob): Promise<void> {
  await cleanupJobArtifacts(job).catch(() => undefined);
  jobs.delete(job.id);
}

function scheduleJobExpiration(job: InternalJob): void {
  const expiresAtMs = Date.now() + env.downloadFileTtlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();

  updateJob(job, {
    expiresAt,
    message: `Ready for download (expires at ${expiresAt})`
  });

  job.cleanupTimer = setTimeout(() => {
    logJob(job.id, `artifact expired at ${expiresAt}, cleaning up`);
    void cleanupAndDeleteJob(job);
  }, env.downloadFileTtlMs);
}

async function buildZipArchive(job: InternalJob, results: DownloadResult[]): Promise<{ filePath: string; downloadName: string }> {
  const archiveName = `youtube-downloads-${Date.now()}-${job.id}.zip`;
  const archivePath = path.join(job.outputDir, `archive-${job.id}.zip`);

  await fsPromises.mkdir(job.outputDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    for (const file of results) {
      archive.file(file.filePath, { name: file.downloadName });
    }

    void archive.finalize();
  });

  return {
    filePath: archivePath,
    downloadName: archiveName
  };
}

async function processJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  try {
    updateJob(job, {
      status: "running",
      message: createProgressMessage(0, job.progress.total, "starting"),
      progress: { current: 0, percent: 0, itemPercent: 0, stage: "starting" }
    });

    const results: DownloadResult[] = [];
    const total = job.progress.total;
    let completed = 0;

    for (let urlIndex = 0; urlIndex < job.urls.length; urlIndex += 1) {
      for (const format of job.formats) {
        const currentItem = completed + 1;
        const requestLabel = `${urlIndex + 1}/${job.urls.length} ${format}`;

        updateJob(job, {
          message: createProgressMessage(currentItem, total, "preparing", requestLabel),
          progress: {
            current: currentItem,
            percent: normalizePercent(currentItem, total, 5),
            itemPercent: 5,
            stage: "preparing",
            detail: requestLabel
          }
        });

        const prepared = await prepareDownload({
          url: job.urls[urlIndex],
          format,
          cookiesFilePath: job.cookiesFilePath,
          signal: job.abortController.signal,
          progress: (stage, detail, stagePercent) => {
            updateJob(job, {
              message: createProgressMessage(currentItem, total, stage, detail),
              progress: {
                current: currentItem,
                percent: normalizePercent(currentItem, total, stagePercent),
                itemPercent: Math.max(0, Math.min(100, stagePercent ?? 0)),
                stage,
                detail
              }
            });
          }
        });

        results.push(prepared);
        job.cleanupPaths.push(prepared.cleanup);
        completed += 1;

        updateJob(job, {
          message: createProgressMessage(completed, total, "completed", prepared.downloadName),
          progress: {
            current: completed,
            percent: normalizePercent(completed, total, 100),
            itemPercent: 100,
            stage: "completed",
            detail: prepared.downloadName
          }
        });
      }
    }

    let finalArtifact: { filePath: string; downloadName: string };
    if (results.length === 1) {
      finalArtifact = {
        filePath: results[0].filePath,
        downloadName: results[0].downloadName
      };
    } else {
      updateJob(job, {
        message: createProgressMessage(total, total, "packaging", "building zip"),
        progress: {
          current: total,
          percent: 96,
          itemPercent: 96,
          stage: "packaging",
          detail: "building zip"
        }
      });
      finalArtifact = await buildZipArchive(job, results);
    }

    job.filePath = finalArtifact.filePath;
    job.downloadName = finalArtifact.downloadName;
    updateJob(job, {
      status: "completed",
      message: "Ready for download",
      progress: {
        current: total,
        percent: 100,
        itemPercent: 100,
        stage: "completed",
        detail: finalArtifact.downloadName
      }
    });

    scheduleJobExpiration(job);
  } catch (error) {
    const isAbort =
      job.abortController.signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message)));
    const message =
      error instanceof Error
        ? error.message
        : isAbort
          ? "Download was cancelled."
          : "Download failed.";
    updateJob(job, {
      status: isAbort ? "cancelled" : "failed",
      message,
      error: isAbort ? undefined : message,
      progress: {
        current: job.progress.current,
        percent: job.progress.percent,
        itemPercent: job.progress.itemPercent,
        stage: isAbort ? "cancelled" : "failed",
        detail: message
      }
    });
  } finally {
    if (job.status === "failed" || job.status === "cancelled") {
      await cleanupAndDeleteJob(job);
    }
  }
}

export function createDownloadJob(input: JobInput): DownloadJobSummary {
  const id = crypto.randomUUID();
  const total = Math.max(1, input.urls.length * input.formats.length);
  const createdAt = nowIso();

  const job: InternalJob = {
    id,
    status: "queued",
    progress: {
      current: 0,
      total,
      percent: 0,
      itemPercent: 0,
      stage: "queued"
    },
    message: "Queued",
    createdAt,
    updatedAt: createdAt,
    urls: input.urls,
    formats: input.formats,
    cookiesFilePath: input.cookiesFilePath,
    outputDir: path.join(env.tempRoot, `job-${id}`),
    cleanupPaths: [],
    abortController: new AbortController()
  };

  void fsPromises.mkdir(job.outputDir, { recursive: true });
  jobs.set(id, job);
  logJob(id, `created urls=${input.urls.length} formats=${input.formats.join(",")} total=${total}`);
  void processJob(id);

  return summarizeJob(job);
}

export function summarizeJob(job: InternalJob): DownloadJobSummary {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    downloadName: job.downloadName,
    error: job.error,
    expiresAt: job.expiresAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export function getDownloadJob(jobId: string): DownloadJobSummary {
  const job = jobs.get(jobId);
  if (!job) {
    throw new AppError("Download job not found.", 404);
  }

  return summarizeJob(job);
}

export async function getDownloadJobFile(jobId: string): Promise<{ filePath: string; downloadName: string; cleanup: () => Promise<void> }> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new AppError("Download job not found.", 404);
  }

  if (job.status !== "completed" || !job.filePath || !job.downloadName) {
    throw new AppError("Download is not ready yet.", 409);
  }

  return {
    filePath: job.filePath,
    downloadName: job.downloadName,
    cleanup: async () => {
      await cleanupAndDeleteJob(job);
    }
  };
}

export async function cancelDownloadJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  if (job.status === "completed") {
    logJob(job.id, "cancel requested after completion; cleaning up artifact");
    await cleanupAndDeleteJob(job);
    return;
  }

  if (job.status === "failed" || job.status === "cancelled") {
    await cleanupAndDeleteJob(job);
    return;
  }

  updateJob(job, {
    status: "cancelled",
    message: "Download cancelled by client",
    progress: {
      stage: "cancelled",
      detail: "client disconnected"
    }
  });

  job.abortController.abort();
}
