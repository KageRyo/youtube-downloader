import { Router } from "express";
import multer from "multer";
import { createDownloadRateLimit } from "../middleware/downloadRateLimit";

import { cancelJobHandler, createJobHandler, getJobFileHandler, getJobItemFileHandler, getJobStatusHandler, healthHandler } from "../controllers/downloadController";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 4,
    parts: 6,
    fieldSize: 64 * 1024
  }
});

export function createDownloadRoutes() {
  const downloadRoutes = Router();

  downloadRoutes.get("/health", healthHandler);
  downloadRoutes.post("/download", createDownloadRateLimit(), upload.single("cookiesFile"), createJobHandler);
  downloadRoutes.get("/download/:jobId", getJobStatusHandler);
  downloadRoutes.get("/download/:jobId/file", getJobFileHandler);
  downloadRoutes.get("/download/:jobId/items/:itemId/file", getJobItemFileHandler);
  downloadRoutes.post("/download/:jobId/cancel", cancelJobHandler);

  return downloadRoutes;
}
