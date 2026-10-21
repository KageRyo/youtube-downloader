import { AppError } from "./errors";
import { DownloadFormat, DownloadOptions, DownloadSelection, SubtitleSource } from "../types/download";

function optionalPreset(value: unknown, choices: number[], name: string): number | undefined {
  if (value === undefined || value === "" || value === "best") return undefined;
  if (typeof value !== "string" || !choices.map(String).includes(value)) throw new AppError(`Unsupported ${name}.`, 400);
  return Number(value);
}

export function isSubtitleFormat(format: DownloadFormat): boolean { return format === "srt" || format === "vtt"; }

function subtitleSource(value: unknown): SubtitleSource {
  if (value === undefined || value === "" || value === "manual") return "manual";
  if (value === "automatic") return value;
  throw new AppError("Select manual or automatic subtitle source.", 400);
}

function subtitleLanguage(value: unknown): string {
  if (typeof value !== "string" || value.length > 35 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value) || value === "all" || value === "live_chat") {
    throw new AppError("Select an exact subtitle language tag such as en or zh-Hant.", 400);
  }
  return value;
}

export function parseDownloadOptions(body: Record<string, unknown>): DownloadOptions {
  const rawLanguages = body.subtitleLanguages;
  const languages = rawLanguages === undefined || rawLanguages === "" ? undefined
    : (typeof rawLanguages === "string" ? rawLanguages.split(",").map((value) => value.trim()) : Array.isArray(rawLanguages) ? rawLanguages : [rawLanguages]);
  if (languages && (languages.length === 0 || languages.length > 5)) throw new AppError("Select between 1 and 5 subtitle languages.", 400);
  return {
    subtitleLanguages: languages ? [...new Set(languages.map(subtitleLanguage))] : undefined,
    subtitleSource: subtitleSource(body.subtitleSource),
    videoResolution: optionalPreset(body.videoResolution, [480, 720, 1080, 2160], "video resolution"),
    audioBitrate: optionalPreset(body.audioBitrate, [128, 192, 256, 320], "MP3 bitrate")
  };
}

export function parseYouTubeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("A YouTube URL is required.", 400);
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new AppError("Invalid URL format.", 400); }
  const host = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      !["youtu.be", "youtube.com", "youtube-nocookie.com"].some((allowed) => host === allowed || allowed !== "youtu.be" && host.endsWith(`.${allowed}`))) {
    throw new AppError("Only YouTube URLs are supported.", 400);
  }
  return parsed.toString();
}

export function isDownloadFormat(value: unknown): value is DownloadFormat {
  return value === "mp3" || value === "mp4" || value === "srt" || value === "vtt";
}

export function parseSelections(value: unknown): DownloadSelection[] | undefined {
  if (value === undefined) return undefined;
  let items: unknown;
  try { items = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new AppError("Invalid retry item selection.", 400); }
  if (!Array.isArray(items) || items.length === 0 || items.length > 60) throw new AppError("Select between 1 and 60 download items.", 400);
  const selected: DownloadSelection[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || !isDownloadFormat(item.format)) throw new AppError("Invalid download item format.", 400);
    const url = parseYouTubeUrl(item.url);
    const caption = isSubtitleFormat(item.format);
    const language = caption ? subtitleLanguage(item.subtitleLanguage) : undefined;
    const source = caption ? subtitleSource(item.subtitleSource) : undefined;
    const key = `${url}\0${item.format}\0${language ?? ""}\0${source ?? ""}`;
    if (!seen.has(key)) selected.push({ url, format: item.format, ...(caption ? { subtitleLanguage: language, subtitleSource: source } : {}) });
    seen.add(key);
  }
  if (new Set(selected.map((item) => item.url)).size > 30) throw new AppError("A maximum of 30 URLs is allowed per request.", 400);
  return selected;
}
