import express, { NextFunction, Request, Response } from "express";
import path from "node:path";

import { downloadRoutes } from "./routes/downloadRoutes";
import { AppError } from "./utils/errors";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.resolve(process.cwd(), "public")));

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const stamp = new Date().toISOString();
    console.log(`[api ${stamp}] ${req.method} ${req.originalUrl} started`);

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      console.log(`[api ${stamp}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`);
    });

    next();
  });

  app.use("/api", downloadRoutes);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }

    console.error(error);
    res.status(500).json({ message: "An unexpected server error occurred." });
  });

  return app;
}
