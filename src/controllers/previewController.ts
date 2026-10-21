import { Request, Response, NextFunction } from "express";
import { parseYouTubeUrl } from "../utils/downloadOptions";
import { AppError } from "../utils/errors";
import { previewVideos } from "../services/videoPreviewService";

export async function previewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", disconnected);
  try {
    if (!Array.isArray(req.body.urls) || req.body.urls.length < 1 || req.body.urls.length > 30) throw new AppError("Preview requires between 1 and 30 YouTube URLs.", 400);
    const urls = [...new Set<string>(req.body.urls.map(parseYouTubeUrl))];
    const items = await previewVideos(urls, controller.signal);
    if (!controller.signal.aborted) res.json({ items });
  } catch (error) { next(error); }
  finally { res.removeListener("close", disconnected); }
}
