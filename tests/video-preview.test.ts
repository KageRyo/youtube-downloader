import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runCommand: vi.fn(), isCommandAvailable: vi.fn() }));
vi.mock("../src/utils/process", () => mocks);
import { createApp } from "../src/app";
import { env } from "../src/config/env";

const metadata = { id: "a", title: "<script>private title</script>", duration: 120, thumbnail: "https://i.ytimg.com/vi/a/hqdefault.jpg?token=private", availability: "public", cookies: "must not leak" };
let root: string;
let previous: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-preview-")); previous = env.tempRoot; env.tempRoot = root;
  mocks.runCommand.mockReset().mockResolvedValue({ code: 0, stdout: JSON.stringify(metadata), stderr: "" });
});
afterEach(async () => { env.tempRoot = previous; await fs.rm(root, {recursive:true,force:true}); });

it("previews selected metadata without media artifacts or private fields", async () => {
  const response = await request(createApp()).post("/api/preview").send({urls:["https://youtu.be/a"]}).expect(200);
  expect(response.body.items[0]).toMatchObject({title:metadata.title,duration:120,thumbnail:"https://i.ytimg.com/vi/a/hqdefault.jpg"});
  expect(JSON.stringify(response.body)).not.toMatch(/cookies|must not leak|token=private/);
  const args = mocks.runCommand.mock.calls[0][1];
  expect(args).toContain("--skip-download"); expect(args).toContain("--simulate");
  expect(args).not.toContain("-o"); expect(args).not.toContain("--cookies-from-browser");
  expect(await fs.readdir(root)).toEqual([]);
});

it("rejects non-YouTube input before running a process", async () => {
  await request(createApp()).post("/api/preview").send({urls:["https://example.com/a"]}).expect(400);
  expect(mocks.runCommand).not.toHaveBeenCalled();
});

it("reports unavailable items and filters untrusted thumbnails", async () => {
  mocks.runCommand.mockResolvedValueOnce({code:1,stdout:"",stderr:"Private video cookies=/private/secret"})
    .mockResolvedValueOnce({code:0,stdout:JSON.stringify({...metadata,thumbnail:"http://127.0.0.1/internal"}),stderr:""});
  const response = await request(createApp()).post("/api/preview").send({urls:["https://youtu.be/a","https://youtu.be/b"]}).expect(200);
  expect(response.body.items[0].error).toMatch(/unavailable|private/i);
  expect(response.body.items[1].thumbnail).toBeNull();
  expect(JSON.stringify(response.body)).not.toContain("/private/secret");
});

it("bounds concurrent preview requests and releases capacity", async () => {
  const { previewVideos } = await import("../src/services/videoPreviewService");
  const releases: Array<() => void> = [];
  mocks.runCommand.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve({code:0,stdout:JSON.stringify(metadata),stderr:""}))));
  const a = previewVideos(["https://youtu.be/a"]);
  const b = previewVideos(["https://youtu.be/b"]);
  await expect(previewVideos(["https://youtu.be/c"])).rejects.toMatchObject({statusCode:503});
  releases.forEach((release) => release()); await Promise.all([a,b]);
  mocks.runCommand.mockResolvedValue({code:0,stdout:JSON.stringify(metadata),stderr:""});
  expect(await previewVideos(["https://youtu.be/c"])).toHaveLength(1);
});

it("stops launching remaining previews after the caller cancels", async () => {
  const { previewVideos } = await import("../src/services/videoPreviewService");
  const controller = new AbortController();
  mocks.runCommand.mockImplementation((_command, _args, options) => new Promise((_resolve,reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), {once:true})));
  const pending = previewVideos(["https://youtu.be/a","https://youtu.be/b"], controller.signal);
  controller.abort();
  expect(await pending).toHaveLength(2);
  expect(mocks.runCommand).toHaveBeenCalledTimes(1);
});
