export type DownloadFormat = "mp3" | "mp4";

export interface DownloadRequest {
  url: string;
  format: DownloadFormat;
  cookiesFilePath?: string;
}

export interface DownloadResult {
  filePath: string;
  downloadName: string;
  cleanup: () => Promise<void>;
}
