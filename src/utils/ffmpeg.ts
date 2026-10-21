import fs from "node:fs";
import path from "node:path";

// Use one complete pair; mixing a local ffmpeg with PATH ffprobe changes yt-dlp's lookup.
export function getFfmpegLocation(): string | undefined {
  const directory = path.resolve(process.cwd(), "tools", "bin");
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    for (const tool of ["ffmpeg", "ffprobe"]) {
      fs.accessSync(path.join(directory, `${tool}${suffix}`), fs.constants.X_OK);
    }
    return directory;
  } catch {
    return undefined;
  }
}
