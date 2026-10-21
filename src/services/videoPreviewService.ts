import { runCommand } from "../utils/process";
import { AppError } from "../utils/errors";

export interface VideoPreview {
  url: string;
  title?: string;
  duration?: number | null;
  thumbnail?: string | null;
  error?: string;
}
let activePreviews = 0;

function thumbnailUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^(?:i[0-9]?\.ytimg\.com|img\.youtube\.com)$/.test(url.hostname)) return null;
    url.search = ""; url.hash = "";
    return url.toString();
  } catch { return null; }
}

export async function previewVideos(urls: string[], signal?: AbortSignal): Promise<VideoPreview[]> {
  if (activePreviews >= 2) throw new AppError("Video preview is busy. Retry later.", 503);
  activePreviews += 1;
  const batch = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  try {
    const items: VideoPreview[] = [];
    for (const url of urls) {
      if (batch.aborted) { items.push({ url, error: "Video preview timed out or was cancelled." }); continue; }
      try {
        const result = await runCommand("yt-dlp", ["--ignore-config", "--no-cache-dir", "--no-playlist", "--simulate", "--skip-download", "--no-warnings", "--js-runtimes", `node:${process.execPath}`, "--print", "%(.{id,title,duration,thumbnail,availability})j", url], {
          signal: AbortSignal.any([batch, AbortSignal.timeout(15_000)])
        });
        if (result.code !== 0) throw new Error("Unavailable video");
        const metadata = JSON.parse(result.stdout.trim());
        if (typeof metadata.title !== "string" || !metadata.title.trim()) throw new Error("Missing title");
        items.push({ url, title: metadata.title.slice(0, 500), duration: typeof metadata.duration === "number" && Number.isFinite(metadata.duration) && metadata.duration >= 0 ? metadata.duration : null, thumbnail: thumbnailUrl(metadata.thumbnail) });
      } catch {
        items.push({ url, error: "Video is unavailable, private, or requires sign-in; check the URL and your access." });
      }
    }
    return items;
  } finally { activePreviews -= 1; }
}
