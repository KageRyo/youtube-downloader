import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    prepareDownload: vi.fn()
  };
});

vi.mock("../src/services/downloaderService", () => ({
  prepareDownload: mocks.prepareDownload
}));

import { createDownloadJob, getDownloadJob } from "../src/services/downloadJobService";

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
});
