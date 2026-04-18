import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    createDownloadJob: vi.fn(),
    getDownloadJob: vi.fn(),
    getDownloadJobFile: vi.fn(),
    cancelDownloadJob: vi.fn()
  };
});

vi.mock("../src/services/downloadJobService", () => ({
  createDownloadJob: mocks.createDownloadJob,
  getDownloadJob: mocks.getDownloadJob,
  getDownloadJobFile: mocks.getDownloadJobFile,
  cancelDownloadJob: mocks.cancelDownloadJob
}));

import { createApp } from "../src/app";

const app = createApp();

const queuedJob = {
  id: "job-123",
  status: "queued",
  message: "Queued",
  progress: {
    current: 0,
    total: 2,
    percent: 0,
    itemPercent: 0,
    stage: "queued"
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("download api", () => {
  beforeEach(() => {
    mocks.createDownloadJob.mockReset();
    mocks.getDownloadJob.mockReset();
    mocks.getDownloadJobFile.mockReset();
    mocks.cancelDownloadJob.mockReset();
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  it("returns health status", async () => {
    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toEqual({ ok: true });
  });

  it("rejects non-youtube url", async () => {
    const response = await request(app)
      .post("/api/download")
      .field("urls", "https://example.com/video")
      .field("format", "mp3")
      .expect(400);

    expect(response.body.message).toContain("Only YouTube URLs are supported");
    expect(mocks.createDownloadJob).not.toHaveBeenCalled();
  });

  it("creates job with parsed urls and unique formats", async () => {
    mocks.createDownloadJob.mockReturnValue(queuedJob);

    const response = await request(app)
      .post("/api/download")
      .field("urls", "https://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://youtu.be/aqz-KE-bpKQ")
      .field("format", "mp3")
      .field("format", "mp4")
      .field("format", "mp3")
      .expect(202);

    expect(response.body.id).toBe("job-123");
    expect(mocks.createDownloadJob).toHaveBeenCalledTimes(1);

    const input = mocks.createDownloadJob.mock.calls[0]?.[0];
    expect(input.formats).toEqual(["mp3", "mp4"]);
    expect(input.urls).toHaveLength(2);
    expect(input.urls[0]).toContain("youtube.com/watch");
    expect(input.urls[1]).toContain("youtu.be/");
  });

  it("returns job status by id", async () => {
    mocks.getDownloadJob.mockReturnValue({
      ...queuedJob,
      id: "job-status",
      status: "running",
      message: "running"
    });

    const response = await request(app).get("/api/download/job-status").expect(200);

    expect(response.body.id).toBe("job-status");
    expect(mocks.getDownloadJob).toHaveBeenCalledWith("job-status");
  });

  it("streams completed file and triggers cleanup", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-test-"));
    const filePath = path.join(tmpDir, "sample.mp3");
    await fs.writeFile(filePath, "binary-data");

    const cleanup = vi.fn(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    mocks.getDownloadJobFile.mockResolvedValue({
      filePath,
      downloadName: "sample.mp3",
      cleanup
    });

    const response = await request(app).get("/api/download/job-file/file").expect(200);

    expect(response.headers["content-disposition"]).toContain("sample.mp3");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cancels active job", async () => {
    mocks.cancelDownloadJob.mockResolvedValue(undefined);

    await request(app).post("/api/download/job-cancel/cancel").expect(202, { ok: true });

    expect(mocks.cancelDownloadJob).toHaveBeenCalledWith("job-cancel");
  });
});
