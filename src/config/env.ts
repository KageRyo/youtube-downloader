import "dotenv/config";
import path from "node:path";
import os from "node:os";

const fallbackPort = 3000;
const parsedPort = Number(process.env.PORT ?? fallbackPort);

export const env = {
  port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : fallbackPort,
  tempRoot: process.env.DOWNLOADER_TMP_DIR ?? path.join(os.tmpdir(), "youtube-downloader")
};
