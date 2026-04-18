import path from "node:path";

export function sanitizeFileName(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .slice(0, 120);

  return cleaned || "download";
}

export function withExtension(fileName: string, ext: string): string {
  return `${sanitizeFileName(path.parse(fileName).name)}${ext}`;
}
