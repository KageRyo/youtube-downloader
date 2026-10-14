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
import { inflateRawSync } from "node:zlib";

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

// Read the central directory because archiver streams sizes in data descriptors.
// This only extracts the small, unencrypted ZIP fixtures produced by these tests.
async function extractTestZip(filePath: string, outputDir: string): Promise<string[]> {
  const zip = await fs.readFile(filePath);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  await fs.mkdir(outputDir);
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localOffset = zip.readUInt32LE(offset + 42);
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataOffset = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    expect([0, 8]).toContain(method);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(content.length).toBe(size);
    await fs.writeFile(path.join(outputDir, name), content);
    names.push(name);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return names;
}

describe("download job service", () => {
  it.each([
    { scenario: "unique names and different extensions", input: ["same.mp4", "same.mp3", "other.mp4"], expected: ["same.mp4", "same.mp3", "other.mp4"] },
    { scenario: "identical titles", input: ["same.mp4", "same.mp4"], expected: ["same.mp4", "same (2).mp4"] },
    { scenario: "multiple Unicode duplicates", input: ["音樂🎵.mp3", "音樂🎵.mp3", "音樂🎵.mp3"], expected: ["音樂🎵.mp3", "音樂🎵 (2).mp3", "音樂🎵 (3).mp3"] },
    { scenario: "existing numbered names", input: ["same.mp4", "same.mp4", "same (2).mp4", "same.mp4", "same (3).mp4"], expected: ["same.mp4", "same (4).mp4", "same (2).mp4", "same (5).mp4", "same (3).mp4"] }
  ])("extracts every file without overwrites for $scenario", async ({ input, expected }) => {
    mocks.prepareDownload.mockReset();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-zip-names-"));
    let artifactPath: string | undefined;
    const contents = input.map((_, index) => Buffer.from(`Distinct media payload ${index}\n`, "utf8"));
    try {
      for (const [index, downloadName] of input.entries()) {
        const filePath = path.join(tmpDir, `source-${index}`);
        await fs.writeFile(filePath, contents[index]);
        mocks.prepareDownload.mockResolvedValueOnce({ filePath, downloadName, cleanup: async () => {} });
      }
      const created = createDownloadJob({ urls: input.map((_, index) => `https://youtu.be/video-${index}`), formats: ["mp4"] });
      expect((await waitForTerminalStatus(created.id)).status).toBe("completed");
      const artifact = await getDownloadJobFile(created.id);
      artifactPath = artifact.filePath;
      const outputDir = path.join(tmpDir, "extracted");
      const names = await extractTestZip(artifactPath, outputDir);
      expect(names).toHaveLength(input.length);
      expect(new Set(names).size).toBe(input.length);
      expect([...names].sort()).toEqual([...expected].sort());
      expect((await fs.readdir(outputDir)).sort()).toEqual([...expected].sort());
      for (const [index, name] of expected.entries()) {
        expect(await fs.readFile(path.join(outputDir, name))).toEqual(contents[index]);
      }
    } finally {
      if (artifactPath) await fs.rm(path.dirname(artifactPath), { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

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
