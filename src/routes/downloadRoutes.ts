import { Router } from "express";
import multer from "multer";

import { cancelJobHandler, createJobHandler, getJobFileHandler, getJobStatusHandler, healthHandler } from "../controllers/downloadController";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

export const downloadRoutes = Router();

downloadRoutes.get("/health", healthHandler);
downloadRoutes.post("/download", upload.single("cookiesFile"), createJobHandler);
downloadRoutes.get("/download/:jobId", getJobStatusHandler);
downloadRoutes.get("/download/:jobId/file", getJobFileHandler);
downloadRoutes.post("/download/:jobId/cancel", cancelJobHandler);
