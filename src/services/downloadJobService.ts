import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";

import { DownloadFormat, DownloadOptions, DownloadSelection, DownloadJobItemSummary, DownloadJobSummary, DownloadResult } from "../types/download";
import { AppError } from "../utils/errors";
import { env } from "../config/env";
import { prepareDownload } from "./downloaderService";

interface JobInput extends DownloadOptions {
  items?: DownloadSelection[];
  urls: string[];
  formats: DownloadFormat[];
  cookiesFilePath?: string;
}

interface FailedItem {
  url: string;
  format: DownloadFormat;
  message: string;
}

interface InternalJob extends DownloadJobSummary, DownloadOptions {
  cookiesFilePath?: string;
  filePath?: string;
  outputDir: string;
  urls: string[];
  formats: DownloadFormat[];
  cleanupPaths: Array<() => Promise<void>>;
  itemArtifacts: Map<string, { filePath: string; downloadName: string }>;
  abortController: AbortController;
  cleanupTimer?: NodeJS.Timeout;
  cleanedUp?: boolean;
  done?: Promise<void>;
  failure?: Error;
  reservationReleased?: boolean;
}

const jobs = new Map<string, InternalJob>();
const DOWNLOAD_PROGRESS_MAX = 96;
const pendingJobs: InternalJob[] = [];
const activeJobs = new Set<InternalJob>();
let reservedBytes = 0;
let shuttingDown = false;

function startQueuedJobs(): void {
  while (!shuttingDown && activeJobs.size < env.maxConcurrentJobs && pendingJobs.length > 0) {
    const job = pendingJobs.shift()!;
    activeJobs.add(job);
    job.done = processJob(job.id).finally(() => {
      activeJobs.delete(job);
      startQueuedJobs();
    });
  }
}

async function directoryBytes(directory: string, limit: number): Promise<number> {
  let total = 0;
  for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await directoryBytes(fullPath, limit - total);
      else if (entry.isFile()) total += (await fsPromises.stat(fullPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (total > limit) return total;
  }
  return total;
}

async function checkJobSize(job: InternalJob): Promise<void> {
  if (await directoryBytes(job.outputDir, env.maxJobBytes) > env.maxJobBytes) {
    throw new AppError("Download job exceeded its storage size budget in bytes.", 413);
  }
}

function failBudget(job: InternalJob, error: Error): void {
  if (job.abortController.signal.aborted || job.status !== "running") return;
  job.failure = error;
  job.abortController.abort();
}

export async function shutdownDownloadJobs(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...jobs.values()].map((job) => cancelDownloadJob(job.id)));
  await Promise.all([...jobs.values()].map((job) => job.done));
  await Promise.all([...jobs.values()].map((job) => cleanupJobArtifacts(job)));
}

function throwIfCancelled(job: InternalJob): void {
  if (job.abortController.signal.aborted) {
    if (job.failure) throw job.failure;
    const error = new Error("Download was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

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
  return Math.max(0, Math.min(DOWNLOAD_PROGRESS_MAX, Math.round(overall * DOWNLOAD_PROGRESS_MAX * 10) / 10));
}

function updateJob(
  job: InternalJob,
  patch: Partial<Pick<InternalJob, "status" | "message" | "error" | "downloadName" | "filePath" | "expiresAt">> & {
    progress?: Partial<InternalJob["progress"]>;
  }
): void {
  // Cancellation is terminal; stale downloader callbacks cannot overwrite it.
  if (job.status === "cancelled" && (patch.status && patch.status !== "cancelled" || patch.progress && patch.progress.stage !== "cancelled")) return;
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
      ...patch.progress,
      percent: Math.max(job.progress.percent, patch.progress.percent ?? job.progress.percent)
    };
  }

  job.updatedAt = nowIso();

  const previousBucket = Math.floor(previousItemPercent / 10);
  const nextBucket = Math.floor(job.progress.itemPercent / 10);
  const stageChanged = previousStage !== job.progress.stage;
  const statusChanged = previousStatus !== job.status;
  const bucketChanged = previousBucket !== nextBucket;

  if (statusChanged || stageChanged || bucketChanged || patch.error) {
    logJob(
      job.id,
      `status=${job.status} stage=${job.progress.stage} item=${job.progress.itemPercent.toFixed(1)}% total=${job.progress.percent.toFixed(1)}% current=${job.progress.current}/${job.progress.total}`
    );
  }
}

async function cleanupJobArtifacts(job: InternalJob): Promise<void> {
  if (job.cleanedUp) {
    return;
  }
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = undefined;
  }
  const failures: unknown[] = [];
  for (const cleanup of job.cleanupPaths) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  for (const directory of [job.outputDir, ...(job.cookiesFilePath ? [path.dirname(job.cookiesFilePath)] : [])]) {
    try { await fsPromises.rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  job.itemArtifacts.clear();
  if (failures.length > 0) throw new AggregateError(failures, "Could not clean all download artifacts.");
  job.cleanedUp = true;
  if (!job.reservationReleased) {
    job.reservationReleased = true;
    reservedBytes -= env.maxJobBytes;
  }
}

async function cleanupAndDeleteJob(job: InternalJob): Promise<void> {
  try {
    await cleanupJobArtifacts(job);
    jobs.delete(job.id);
  } catch {
    logJob(job.id, "artifact cleanup failed; retaining storage reservation and retrying after TTL");
    job.cleanupTimer = setTimeout(() => { void cleanupAndDeleteJob(job); }, env.downloadFileTtlMs);
    job.cleanupTimer.unref();
  }
}

function scheduleJobDeletion(job: InternalJob, reason: string): void {
  const expiresAtMs = Date.now() + env.downloadFileTtlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();

  updateJob(job, {
    expiresAt
  });

  job.cleanupTimer = setTimeout(() => {
    logJob(job.id, `${reason}; removing job record at ${expiresAt}`);
    void cleanupAndDeleteJob(job);
  }, env.downloadFileTtlMs);
  job.cleanupTimer.unref();
}

function scheduleJobExpiration(job: InternalJob): void {
  const expiresAtMs = Date.now() + env.downloadFileTtlMs;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const baseMessage = job.message && job.message.trim().length > 0 ? job.message : "Ready for download";

  updateJob(job, {
    expiresAt,
    message: `${baseMessage} (expires at ${expiresAt})`
  });

  job.cleanupTimer = setTimeout(() => {
    logJob(job.id, `artifact expired at ${expiresAt}, cleaning up`);
    void cleanupAndDeleteJob(job);
  }, env.downloadFileTtlMs);
  job.cleanupTimer.unref();
}

async function buildZipArchive(
  job: InternalJob,
  results: DownloadResult[],
  failedItems: FailedItem[] = []
): Promise<{ filePath: string; downloadName: string }> {
  throwIfCancelled(job);
  const archiveName = `youtube-downloads-${Date.now()}-${job.id}.zip`;
  const archivePath = path.join(job.outputDir, `archive-${job.id}.zip`);

  await fsPromises.mkdir(job.outputDir, { recursive: true });

  throwIfCancelled(job);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      archive.abort();
      output.destroy();
    };
    const abort = () => {
      const error = new Error("Download was cancelled while packaging.");
      error.name = "AbortError";
      fail(error);
    };
    output.on("close", () => {
      job.abortController.signal.removeEventListener("abort", abort);
      if (failure) reject(failure); else resolve();
    });
    output.on("error", fail);
    archive.on("error", fail);
    job.abortController.signal.addEventListener("abort", abort, { once: true });

    archive.pipe(output);
    const originalNames = new Set(results.map((file) => file.downloadName));
    const usedNames = new Set<string>();
    for (const file of results) {
      let entryName = file.downloadName;
      if (usedNames.has(entryName)) {
        const { name, ext } = path.parse(file.downloadName);
        let sequence = 2;
        do {
          entryName = `${name} (${sequence++})${ext}`;
        } while (usedNames.has(entryName) || originalNames.has(entryName));
      }
      usedNames.add(entryName);
      archive.file(file.filePath, { name: entryName });
    }

    if (failedItems.length > 0) {
      const lines = [
        "Some items failed during download/conversion.",
        "",
        ...failedItems.map((item, index) => `${index + 1}. [${item.format}] ${item.url}\n   ${item.message}`)
      ];
      archive.append(lines.join("\n"), { name: "failed-list.txt" });
    }

    void archive.finalize().catch(fail);
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

  let timeout: NodeJS.Timeout | undefined;
  let monitor: NodeJS.Timeout | undefined;
  let checking: Promise<void> | undefined;
  let monitoring = false;
  try {
    await fsPromises.mkdir(job.outputDir, { recursive: true });
    throwIfCancelled(job);
    updateJob(job, {
      status: "running",
      message: createProgressMessage(0, job.progress.total, "starting"),
      progress: { current: 0, percent: 0, itemPercent: 0, stage: "starting" }
    });

    timeout = setTimeout(() => failBudget(job, new AppError("Download job exceeded its time limit.", 408)), env.jobTimeoutMs);
    monitoring = true;
    monitor = setInterval(() => {
      if (checking) return;
      checking = checkJobSize(job).catch((error: Error) => {
        if (monitoring) failBudget(job, error);
      }).finally(() => { checking = undefined; });
    }, 1000);

    const results: DownloadResult[] = [];
    const failedItems: FailedItem[] = [];
    const total = job.progress.total;
    let completed = 0;
    let processed = 0;

    for (const item of job.items) {
        throwIfCancelled(job);
        const format = item.format;
        const currentItem = processed + 1;
        const requestLabel = `${currentItem}/${total} ${format}`;
        item.status = "running";

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

        try {
          const prepared = await prepareDownload({
            url: item.url,
            format,
            cookiesFilePath: job.cookiesFilePath,
            tempRoot: job.outputDir,
            maxBytes: env.maxJobBytes,
            videoResolution: job.videoResolution,
            audioBitrate: job.audioBitrate,
            signal: job.abortController.signal,
            progress: (stage, detail, stagePercent) => {
              if (job.abortController.signal.aborted) return;
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

          job.cleanupPaths.push(prepared.cleanup);
          throwIfCancelled(job);
          await checkJobSize(job);
          throwIfCancelled(job);
          results.push(prepared);
          job.itemArtifacts.set(item.id, {
            filePath: prepared.filePath,
            downloadName: prepared.downloadName
          });
          item.status = "completed";
          item.downloadName = prepared.downloadName;
          item.error = undefined;
          completed += 1;
          processed += 1;

          updateJob(job, {
            message: createProgressMessage(processed, total, "completed", prepared.downloadName),
            progress: {
              current: processed,
              percent: normalizePercent(processed, total, 100),
              itemPercent: 100,
              stage: "completed",
              detail: prepared.downloadName
            }
          });
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 413) { job.failure = error; throw error; }
          throwIfCancelled(job);
          if (error instanceof Error && error.name === "AbortError") throw error;
          processed += 1;
          const message = error instanceof Error ? error.message : "Unknown item error";
          failedItems.push({
            url: item.url,
            format,
            message
          });
          item.status = "failed";
          item.error = message;
          item.downloadName = undefined;

          updateJob(job, {
            message: createProgressMessage(processed, total, "item-failed", message),
            progress: {
              current: processed,
              percent: normalizePercent(processed, total, 100),
              itemPercent: 100,
              stage: "item-failed",
              detail: message
            }
          });
        }
    }

    throwIfCancelled(job);
    if (results.length === 0) {
      const firstError = failedItems[0]?.message ?? "No output file was produced.";
      throw new AppError(`All ${failedItems.length} download items failed. First error: ${firstError}`, 400);
    }

    let finalArtifact: { filePath: string; downloadName: string };
    if (results.length === 1 && failedItems.length === 0) {
      finalArtifact = {
        filePath: results[0].filePath,
        downloadName: results[0].downloadName
      };
    } else {
      updateJob(job, {
        message: createProgressMessage(total, total, "packaging", "building zip"),
        progress: {
          current: total,
          percent: DOWNLOAD_PROGRESS_MAX,
          itemPercent: 96,
          stage: "packaging",
          detail: "building zip"
        }
      });
      finalArtifact = await buildZipArchive(job, results, failedItems);
    }

    await checkJobSize(job);
    throwIfCancelled(job);
    job.filePath = finalArtifact.filePath;
    job.downloadName = finalArtifact.downloadName;
    updateJob(job, {
      status: "completed",
      message: failedItems.length > 0 ? `Ready with partial success (${failedItems.length} failed, see failed-list.txt)` : "Ready for download",
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
    const isAbort = !job.failure && (job.abortController.signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))));
    const message = job.failure?.message ?? (
      error instanceof Error
        ? error.message
        : isAbort
          ? "Download was cancelled."
          : "Download failed.");
    for (const item of job.items) {
      if (item.status !== "failed") item.status = isAbort ? "cancelled" : "failed";
      item.downloadName = undefined;
    }
    job.downloadName = undefined;
    job.filePath = undefined;
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
    monitoring = false;
    if (timeout) clearTimeout(timeout);
    if (monitor) clearInterval(monitor);
    await checking;
    if (job.status === "failed" || job.status === "cancelled") {
      await cleanupJobArtifacts(job).catch(() => logJob(job.id, "cleanup failed; retained for retry"));
      scheduleJobDeletion(job, `job ended with status=${job.status}`);
    }
  }
}

export function createDownloadJob(input: JobInput): DownloadJobSummary {
  if (shuttingDown) throw new AppError("Download server is shutting down.", 503);
  if (jobs.size >= env.maxRetainedJobs) throw new AppError("Retained job capacity reached. Retry after files expire.", 503);
  if (activeJobs.size + pendingJobs.length >= env.maxConcurrentJobs + env.maxQueuedJobs) throw new AppError("Download queue is at capacity. Retry later.", 503);
  if (reservedBytes + env.maxJobBytes > env.maxStorageBytes) throw new AppError("Download storage capacity reached. Retry after files expire.", 503);
  const id = crypto.randomUUID();
  const selections = input.items ?? input.urls.flatMap((url) => input.formats.map((format) => ({ url, format })));
  const items: DownloadJobItemSummary[] = selections.map((item) => ({ ...item, id: crypto.randomUUID(), status: "pending" }));
  const total = items.length;
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
    items,
    successfulItems: 0,
    failedItems: 0,
    createdAt,
    updatedAt: createdAt,
    videoResolution: input.videoResolution,
    audioBitrate: input.audioBitrate,
    urls: input.urls,
    formats: input.formats,
    cookiesFilePath: input.cookiesFilePath,
    outputDir: path.join(env.tempRoot, `job-${id}`),
    cleanupPaths: [],
    itemArtifacts: new Map<string, { filePath: string; downloadName: string }>(),
    abortController: new AbortController()
  };

  jobs.set(id, job);
  reservedBytes += env.maxJobBytes;
  pendingJobs.push(job);
  logJob(id, `created urls=${input.urls.length} formats=${input.formats.join(",")} total=${total}`);
  queueMicrotask(startQueuedJobs);

  return summarizeJob(job);
}

export function summarizeJob(job: InternalJob): DownloadJobSummary {
  const successfulItems = job.items.filter((item) => item.status === "completed").length;
  const failedItems = job.items.filter((item) => item.status === "failed").length;

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    items: job.items.map((item) => ({ ...item })),
    successfulItems,
    failedItems,
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

export async function getDownloadJobFile(jobId: string): Promise<{ filePath: string; downloadName: string }> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new AppError("Download job not found.", 404);
  }

  if (job.status !== "completed" || !job.filePath || !job.downloadName) {
    throw new AppError("Download is not ready yet.", 409);
  }

  return {
    filePath: job.filePath,
    downloadName: job.downloadName
  };
}

export function getDownloadJobItemFile(jobId: string, itemId: string): { filePath: string; downloadName: string } {
  const job = jobs.get(jobId);
  if (!job) {
    throw new AppError("Download job not found.", 404);
  }

  const file = job.itemArtifacts.get(itemId);
  if (!file) {
    throw new AppError("Download item file not found.", 404);
  }

  return file;
}

export async function cancelDownloadJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  if (job.status === "completed") {
    // Completed artifacts are already controlled by TTL; ignore late cancel requests
    // so a page unload during download navigation cannot delete files prematurely.
    logJob(job.id, "cancel requested after completion; ignored (artifact kept until TTL)");
    return;
  }

  if (job.status === "failed" || job.status === "cancelled") {
    // Keep terminal status temporarily so polling clients can read the final error.
    // Job metadata will be removed by scheduled cleanup.
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
  const queuedIndex = pendingJobs.indexOf(job);
  if (queuedIndex >= 0) {
    pendingJobs.splice(queuedIndex, 1);
    job.done = processJob(job.id);
  }
}
