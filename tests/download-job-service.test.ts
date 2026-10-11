import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    prepareDownload: vi.fn()
  };
});

vi.mock("../src/services/downloaderService", () => ({
  prepareDownload: mocks.prepareDownload
}));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDownloadJob, getDownloadJob, getDownloadJobFile, getDownloadJobItemFile } from "../src/services/downloadJobService";

async function waitForTerminalStatus(jobId: string, timeoutMs = 2000): Promise<ReturnType<typeof getDownloadJob>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const job = getDownloadJob(jobId);
    if (job.status === "failed" || job.status === "cancelled" || job.status === "completed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for terminal job status");
}

describe("download job service", () => {
  it.each(["batch", "partial success", "single file"])("keeps overall progress monotonic until the %s artifact is ready", async (scenario) => {
    mocks.prepareDownload.mockReset();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-progress-"));
    const outputFile = path.join(tmpDir, "ok.mp4");
    await fs.writeFile(outputFile, "ok");
    const snapshots: Array<ReturnType<typeof getDownloadJob>> = [];
    const log = vi.spyOn(console, "log").mockImplementation((message: string) => {
      const match = message.match(/^\[job ([^ ]+) /);
      if (match) {
        snapshots.push(getDownloadJob(match[1]));
      }
    });

    mocks.prepareDownload.mockImplementation(async (request) => {
      request.progress("downloading", "download finished", 100);
      request.progress("converting", "conversion started", 90);
      request.progress("converting", "conversion finished", 100);
      if (scenario === "partial success" && request.url.endsWith("b")) {
        throw new Error("Conversion failed");
      }
      return { filePath: outputFile, downloadName: "ok.mp4", cleanup: async () => {} };
    });

    let artifactPath: string | undefined;
    try {
      const created = createDownloadJob({
        urls: scenario === "single file" ? ["https://youtu.be/a"] : ["https://youtu.be/a", "https://youtu.be/b"],
        formats: ["mp4"]
      });
      const terminalJob = await waitForTerminalStatus(created.id);
      const artifact = await getDownloadJobFile(created.id);
      artifactPath = artifact.filePath;
      expect(terminalJob.status).toBe("completed");
      expect(await fs.stat(artifact.filePath)).toBeTruthy();
      expect(artifact.downloadName.endsWith(".zip")).toBe(scenario !== "single file");
      expect(snapshots.some((job) => job.progress.stage === "packaging")).toBe(scenario !== "single file");
      expect(snapshots.filter((job) => job.status !== "completed").every((job) => job.progress.percent < 100)).toBe(true);
      expect(snapshots.filter((job) => job.status === "completed").every((job) => job.progress.percent === 100)).toBe(true);
      const percentages = snapshots.map((job) => job.progress.percent);
      expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    } finally {
      log.mockRestore();
      if (artifactPath && scenario !== "single file") {
        await fs.rm(path.dirname(artifactPath), { recursive: true, force: true });
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps failed job status available for polling clients", async () => {
    mocks.prepareDownload.mockReset();
    mocks.prepareDownload.mockRejectedValue(new Error("yt-dlp validation failed"));

    const created = createDownloadJob({
      urls: ["https://example.invalid/video"],
      formats: ["mp3"]
    });

    const terminalJob = await waitForTerminalStatus(created.id);

    expect(terminalJob.status).toBe("failed");
    expect(terminalJob.error).toContain("yt-dlp validation failed");

    // Failed jobs should not disappear immediately, otherwise clients receive false "expired" messages.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stillReadable = getDownloadJob(created.id);
    expect(stillReadable.status).toBe("failed");
  });

  it("keeps successful items even when one item fails", async () => {
    mocks.prepareDownload.mockReset();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-partial-"));
    const outputFile = path.join(tmpDir, "ok.mp4");
    await fs.writeFile(outputFile, "ok");

    mocks.prepareDownload
      .mockRejectedValueOnce(new Error("Postprocessing: Conversion failed!"))
      .mockResolvedValueOnce({
        filePath: outputFile,
        downloadName: "ok.mp4",
        cleanup: async () => {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });

    const created = createDownloadJob({
      urls: ["https://youtu.be/a", "https://youtu.be/b"],
      formats: ["mp3"]
    });

    const terminalJob = await waitForTerminalStatus(created.id);
    expect(terminalJob.status).toBe("completed");
    expect(terminalJob.downloadName?.endsWith(".zip")).toBe(true);
    expect(terminalJob.message).toContain("partial success");
    const completedItem = terminalJob.items.find((item) => item.status === "completed");
    expect(completedItem).toBeTruthy();
    if (!completedItem) {
      throw new Error("Expected one completed item in partial success job");
    }

    const artifact = await getDownloadJobFile(created.id);
    expect(artifact.downloadName.endsWith(".zip")).toBe(true);

    const itemArtifact = getDownloadJobItemFile(created.id, completedItem.id);
    expect(itemArtifact.downloadName).toBe("ok.mp4");

    // Final artifact now stays available until TTL, so per-item links remain usable.
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
