import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepareDownload: vi.fn() }));
vi.mock("../src/services/downloaderService", () => mocks);
let service: typeof import("../src/services/downloadJobService");
let config: any;
let root: string;
let releases: Array<() => void>;
let started: string[];
const input = (name: string) => ({ urls: [`https://youtu.be/${name}`], formats: ["mp4" as const] });

beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-limits-"));
  config = { tempRoot: root, downloadFileTtlMs: 60000, maxConcurrentJobs: 1, maxQueuedJobs: 1, maxRetainedJobs: 10, maxJobBytes: 1000, maxStorageBytes: 10000, jobTimeoutMs: 60000 };
  vi.doMock("../src/config/env", () => ({ env: config }));
  service = await import("../src/services/downloadJobService");
  releases = [];
  started = [];
  mocks.prepareDownload.mockReset().mockImplementation((request) => new Promise((resolve, reject) => {
    started.push(request.url);
    request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    releases.push(async () => {
      await fs.mkdir(request.tempRoot, { recursive: true });
      const filePath = path.join(request.tempRoot, "video.mp4");
      await fs.writeFile(filePath, "media");
      resolve({ filePath, downloadName: "video.mp4", cleanup: () => fs.rm(filePath, { force: true }) });
    });
  }));
});
afterEach(async () => {
  if (service.shutdownDownloadJobs) await service.shutdownDownloadJobs();
  vi.doUnmock("../src/config/env");
  await fs.rm(root, { recursive: true, force: true });
});

it("bounds workers and queue, releases a cancelled queue slot and recovers after failure", async () => {
  const a = service.createDownloadJob(input("a"));
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const b = service.createDownloadJob(input("b"));
  expect(service.getDownloadJob(b.id).status).toBe("queued");
  expect(() => service.createDownloadJob(input("overload"))).toThrow(/queue|capacity/i);
  expect(started).toHaveLength(1);
  await service.cancelDownloadJob(b.id);
  const c = service.createDownloadJob(input("c"));
  await service.cancelDownloadJob(a.id);
  await vi.waitFor(() => expect(started).toEqual(["https://youtu.be/a", "https://youtu.be/c"]));
  await releases[1]();
  await vi.waitFor(() => expect(service.getDownloadJob(c.id).status).toBe("completed"));
  expect(service.getDownloadJob(b.id).status).toBe("cancelled");
});

it("bounds retained job records independently of queue capacity", async () => {
  config.maxRetainedJobs = 1;
  const a = service.createDownloadJob(input("a"));
  await vi.waitFor(() => expect(started).toHaveLength(1));
  await releases[0]();
  await vi.waitFor(() => expect(service.getDownloadJob(a.id).status).toBe("completed"));
  expect(() => service.createDownloadJob(input("b"))).toThrow(/retained|capacity/i);
});

it("reserves storage for active, queued and retained output", async () => {
  config.maxStorageBytes = 1000;
  service.createDownloadJob(input("a"));
  expect(() => service.createDownloadJob(input("b"))).toThrow(/storage/i);
});

it("times out running work, cleans files and starts the next queued job", async () => {
  config.jobTimeoutMs = 60;
  const a = service.createDownloadJob(input("a"));
  const b = service.createDownloadJob(input("b"));
  await vi.waitFor(() => expect(service.getDownloadJob(a.id).status).toBe("failed"));
  expect(service.getDownloadJob(a.id).error).toMatch(/time/i);
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(await fs.readdir(root)).not.toContain(`job-${a.id}`);
  await service.cancelDownloadJob(b.id);
});

it("rejects oversized artifacts, cleans output and frees the worker", async () => {
  config.maxJobBytes = 2;
  const a = service.createDownloadJob(input("a"));
  await vi.waitFor(() => expect(started).toHaveLength(1));
  await releases[0]();
  await vi.waitFor(() => expect(service.getDownloadJob(a.id).status).toBe("failed"));
  expect(service.getDownloadJob(a.id).error).toMatch(/size|storage|bytes/i);
  await vi.waitFor(async () => expect(await fs.readdir(root)).toEqual([]));
});

it("shutdown cancels and drains running/queued work and rejects new jobs", async () => {
  const a = service.createDownloadJob(input("a"));
  const b = service.createDownloadJob(input("b"));
  await vi.waitFor(() => expect(started).toHaveLength(1));
  await service.shutdownDownloadJobs();
  expect(service.getDownloadJob(a.id).status).toBe("cancelled");
  expect(service.getDownloadJob(b.id).status).toBe("cancelled");
  expect(started).toHaveLength(1);
  expect(await fs.readdir(root)).toEqual([]);
  expect(() => service.createDownloadJob(input("c"))).toThrow(/shut/i);
});

it("aborts an oversized in-flight download rather than waiting for it to finish", async () => {
  const a = service.createDownloadJob(input("a"));
  await vi.waitFor(() => expect(started).toHaveLength(1));
  await fs.writeFile(path.join(root, `job-${a.id}`, "large.part"), Buffer.alloc(1001));
  await vi.waitFor(() => expect(service.getDownloadJob(a.id).status).toBe("failed"), { timeout: 2500 });
  expect(service.getDownloadJob(a.id).error).toMatch(/storage/);
  await vi.waitFor(async () => expect(await fs.readdir(root)).toEqual([]));
});
