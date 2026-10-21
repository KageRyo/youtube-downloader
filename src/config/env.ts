import "dotenv/config";
import path from "node:path";
import os from "node:os";

const fallbackPort = 3000;
const parsedPort = Number(process.env.PORT ?? fallbackPort);
const fallbackDownloadTtlMinutes = 10;
const parsedDownloadTtlMinutes = Number(process.env.DOWNLOAD_FILE_TTL_MINUTES ?? fallbackDownloadTtlMinutes);
const parsedCookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const env = {
  maxConcurrentJobs: positiveInteger("MAX_CONCURRENT_JOBS", 2),
  maxQueuedJobs: positiveInteger("MAX_QUEUED_JOBS", 8),
  maxRetainedJobs: positiveInteger("MAX_RETAINED_JOBS", 32),
  maxJobBytes: positiveInteger("MAX_JOB_BYTES", 512 * 1024 * 1024),
  maxStorageBytes: positiveInteger("MAX_STORAGE_BYTES", 8 * 1024 * 1024 * 1024),
  jobTimeoutMs: positiveInteger("JOB_TIMEOUT_MS", 30 * 60 * 1000),
  creationRateLimit: positiveInteger("CREATION_RATE_LIMIT", 10),
  orphanTempMaxAgeMs: positiveInteger("ORPHAN_TEMP_MAX_AGE_MS", 24 * 60 * 60 * 1000),
  host: process.env.HOST ?? "127.0.0.1",
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : fallbackPort,
  tempRoot: process.env.DOWNLOADER_TMP_DIR ?? path.join(os.tmpdir(), "youtube-downloader"),
  ytDlpCookiesFromBrowser: parsedCookiesFromBrowser && parsedCookiesFromBrowser.length > 0 ? parsedCookiesFromBrowser : undefined,
  downloadFileTtlMs:
    Number.isFinite(parsedDownloadTtlMinutes) && parsedDownloadTtlMinutes > 0
      ? Math.round(parsedDownloadTtlMinutes * 60 * 1000)
      : fallbackDownloadTtlMinutes * 60 * 1000
};
