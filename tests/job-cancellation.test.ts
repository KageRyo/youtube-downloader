import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepareDownload: vi.fn() }));
vi.mock("../src/services/downloaderService", () => mocks);
import { env } from "../src/config/env";
import { cancelDownloadJob, createDownloadJob, getDownloadJob, getDownloadJobItemFile } from "../src/services/downloadJobService";

let root: string;
let originalRoot: string;
beforeEach(async () => {
  originalRoot = env.tempRoot;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-cancel-"));
  env.tempRoot = root;
  mocks.prepareDownload.mockReset();
});
afterEach(async () => {
  env.tempRoot = originalRoot;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function drained(id: string) {
  await vi.waitFor(async () => {
    expect(getDownloadJob(id).status).toBe("cancelled");
    expect(getDownloadJob(id).expiresAt).toBeTruthy();
    expect(await fs.readdir(root)).toEqual([]);
  });
}
async function artifact(index: number) {
  const filePath = path.join(root, `media-${index}.mp4`);
  await fs.writeFile(filePath, "media");
  return { filePath, downloadName: "media.mp4", cleanup: () => fs.rm(filePath, { force: true }) };
}

it("preserves a pre-existing directory when exclusive job ownership fails", async () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const directory = path.join(root, `job-${id}`);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "unrelated.txt"), "keep me");
  vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(id);
  const job = createDownloadJob({ urls: ["https://youtu.be/a"], formats: ["mp4"] });
  await vi.waitFor(() => expect(getDownloadJob(job.id).expiresAt).toBeTruthy());
  expect(getDownloadJob(job.id).status).toBe("failed");
  expect(await fs.readFile(path.join(directory, "unrelated.txt"), "utf8")).toBe("keep me");
});

it("cancels before the first item starts", async () => {
  mocks.prepareDownload.mockRejectedValue(new Error("must not run"));
  const job = createDownloadJob({ urls: ["https://youtu.be/a"], formats: ["mp4"] });
  await cancelDownloadJob(job.id);
  await drained(job.id);
  expect(mocks.prepareDownload).not.toHaveBeenCalled();
  expect(getDownloadJob(job.id).failedItems).toBe(0);
});

it("stops after a partial success, ignores late progress and cleans a late result", async () => {
  const first = await artifact(1);
  const second = await artifact(2);
  let release!: (value: typeof first) => void;
  let activeRequest: any;
  mocks.prepareDownload.mockResolvedValueOnce(first).mockImplementationOnce((request) => {
    activeRequest = request;
    return new Promise((resolve) => { release = resolve; });
  });
  const job = createDownloadJob({ urls: ["https://youtu.be/a", "https://youtu.be/b", "https://youtu.be/c"], formats: ["mp4"] });
  await vi.waitFor(() => expect(activeRequest).toBeTruthy());
  await cancelDownloadJob(job.id);
  activeRequest.progress("running", "late update", 100);
  expect(getDownloadJob(job.id).progress.stage).toBe("cancelled");
  release(second);
  await drained(job.id);
  expect(mocks.prepareDownload).toHaveBeenCalledTimes(2);
  expect(getDownloadJob(job.id).failedItems).toBe(0);
  for (const item of getDownloadJob(job.id).items) {
    expect(() => getDownloadJobItemFile(job.id, item.id)).toThrow();
  }
});

it("treats an abort as cancellation rather than an item conversion failure", async () => {
  let rejectItem!: (error: Error) => void;
  mocks.prepareDownload.mockImplementation(() => new Promise((_resolve, reject) => { rejectItem = reject; }));
  const job = createDownloadJob({ urls: ["https://youtu.be/a", "https://youtu.be/b"], formats: ["mp3", "mp4"] });
  await vi.waitFor(() => expect(rejectItem).toBeTruthy());
  await cancelDownloadJob(job.id);
  rejectItem(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await drained(job.id);
  expect(mocks.prepareDownload).toHaveBeenCalledTimes(1);
  expect(getDownloadJob(job.id).failedItems).toBe(0);
});

it("does not package or complete when cancelled as packaging starts", async () => {
  mocks.prepareDownload.mockResolvedValueOnce(await artifact(1)).mockResolvedValueOnce(await artifact(2));
  vi.spyOn(console, "log").mockImplementation((message: string) => {
    const match = message.match(/^\[job ([^ ]+) .*stage=packaging/);
    if (match) void cancelDownloadJob(match[1]);
  });
  const job = createDownloadJob({ urls: ["https://youtu.be/a", "https://youtu.be/b"], formats: ["mp4"] });
  await drained(job.id);
  expect(getDownloadJob(job.id).downloadName).toBeUndefined();
});
