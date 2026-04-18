export type DownloadFormat = "mp3" | "mp4";

export type DownloadJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DownloadProgressReporter {
  (stage: string, detail?: string, percent?: number): void;
}

export interface DownloadJobProgress {
  current: number;
  total: number;
  percent: number;
  itemPercent: number;
  stage: string;
  detail?: string;
}

export interface DownloadRequest {
  url: string;
  format: DownloadFormat;
  cookiesFilePath?: string;
  progress?: DownloadProgressReporter;
  signal?: AbortSignal;
}

export interface DownloadResult {
  filePath: string;
  downloadName: string;
  cleanup: () => Promise<void>;
}

export interface DownloadJobSummary {
  id: string;
  status: DownloadJobStatus;
  progress: DownloadJobProgress;
  message: string;
  downloadName?: string;
  error?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
