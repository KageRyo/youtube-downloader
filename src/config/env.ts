import "dotenv/config";
import path from "node:path";
import os from "node:os";

const fallbackPort = 3000;
const parsedPort = Number(process.env.PORT ?? fallbackPort);
const fallbackDownloadTtlMinutes = 10;
const parsedDownloadTtlMinutes = Number(process.env.DOWNLOAD_FILE_TTL_MINUTES ?? fallbackDownloadTtlMinutes);

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : fallbackPort,
  tempRoot: process.env.DOWNLOADER_TMP_DIR ?? path.join(os.tmpdir(), "youtube-downloader"),
  downloadFileTtlMs:
    Number.isFinite(parsedDownloadTtlMinutes) && parsedDownloadTtlMinutes > 0
      ? Math.round(parsedDownloadTtlMinutes * 60 * 1000)
      : fallbackDownloadTtlMinutes * 60 * 1000
};
