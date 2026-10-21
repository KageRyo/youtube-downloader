import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/config/env", () => ({
  env: { tempRoot: "", ytDlpCookiesFromBrowser: undefined }
}));

import { env } from "../src/config/env";
import { prepareDownload } from "../src/services/downloaderService";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill(): boolean {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

const request = { url: "https://youtu.be/test", format: "mp4" as const };
let tempRoot: string;
let download: (child: FakeChild, tempDir: string) => void | Promise<void>;

describe("prepareDownload temporary directory lifecycle", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ytdl-prepare-test-"));
    env.tempRoot = tempRoot;
    env.ytDlpCookiesFromBrowser = undefined;
    vi.useFakeTimers();
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChild();
      queueMicrotask(async () => {
        try {
          if (args.includes("--version") || args.includes("-version")) {
            child.emit("close", 0);
            return;
          }
          const tempDir = path.dirname(args[args.indexOf("-o") + 1]);
          await download(child, tempDir);
        } catch (error) {
          child.emit("error", error);
        }
      });
      return child;
    });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each(["PATH", "local", "partial local"])("uses a consistent FFmpeg pair from %s", async (location) => {
    const localDir = path.resolve("tools/bin");
    const suffix = process.platform === "win32" ? ".exe" : "";
    const access = vi.spyOn(fsSync, "accessSync").mockImplementation((target) => {
      const name = path.basename(String(target));
      if (location === "PATH" || (location === "partial local" && name.startsWith("ffprobe"))) {
        throw new Error("ENOENT");
      }
    });
    download = async (child, tempDir) => {
      const args = mocks.spawn.mock.calls.at(-1)![1] as string[];
      if (location === "local") {
        expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe(localDir);
      } else {
        expect(args).not.toContain("--ffmpeg-location");
      }
      const filePath = path.join(tempDir, "audio.mp3");
      await fs.writeFile(filePath, "audio");
      child.stdout.write(`${filePath}\n`);
      child.emit("close", 0);
    };
    const result = await prepareDownload({ ...request, format: "mp3" });
    const checkedTools = mocks.spawn.mock.calls.filter((call) => call[1].includes("-version")).map((call) => call[0]);
    expect(checkedTools).toEqual(location === "local"
      ? [path.join(localDir, `ffmpeg${suffix}`), path.join(localDir, `ffprobe${suffix}`)]
      : ["ffmpeg", "ffprobe"]);
    access.mockRestore();
    await result.cleanup();
  });

  it("rejects a missing ffprobe before creating download files", async () => {
    mocks.spawn.mockImplementation((command: string) => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("close", path.basename(command).startsWith("ffprobe") ? 1 : 0));
      return child;
    });
    await expect(prepareDownload({ ...request, format: "mp3" })).rejects.toThrow(/ffprobe/);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes partial files after a spawn error and preserves the error", async () => {
    const error = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
    download = async (child, tempDir) => {
      await fs.writeFile(path.join(tempDir, "video.mp4.part"), "partial");
      child.emit("error", error);
    };

    await expect(prepareDownload(request)).rejects.toBe(error);
    expect(await fs.readdir(tempRoot)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the directory when spawn throws synchronously", async () => {
    const error = new Error("spawn failed synchronously");
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("-o")) {
        throw error;
      }
      const child = new FakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(prepareDownload(request)).rejects.toBe(error);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes partial files when the browser-cookie retry has a spawn error", async () => {
    env.ytDlpCookiesFromBrowser = "chrome";
    const error = new Error("Retry spawn failed");
    let attempts = 0;
    download = async (child, tempDir) => {
      await fs.writeFile(path.join(tempDir, "video.part"), "partial");
      if (attempts++ === 0) {
        child.stderr.write("Sign in to confirm you're not a bot");
        child.emit("close", 1);
      } else {
        child.emit("error", error);
      }
    };

    await expect(prepareDownload(request)).rejects.toBe(error);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes partial files after an in-flight abort", async () => {
    const controller = new AbortController();
    download = async (_child, tempDir) => {
      await fs.writeFile(path.join(tempDir, "video.mp4.part"), "partial");
      controller.abort();
    };

    await expect(prepareDownload({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes the directory when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(prepareDownload({ ...request, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it.each(["mp4", "mp3"] as const)("removes partial %s output after a nonzero exit", async (format) => {
    download = async (child, tempDir) => {
      await fs.writeFile(path.join(tempDir, "video.part"), "partial");
      child.stderr.write("Postprocessing: Conversion failed!");
      child.emit("close", 1);
    };

    await expect(prepareDownload({ ...request, format })).rejects.toMatchObject({
      message: "Postprocessing: Conversion failed!",
      statusCode: 400
    });
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes the directory when no output file was produced", async () => {
    download = (child, tempDir) => {
      child.stdout.write(`${path.join(tempDir, "missing.mp4")}\n`);
      child.emit("close", 0);
    };

    await expect(prepareDownload(request)).rejects.toMatchObject({ statusCode: 500 });
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it("removes partial files when output discovery throws", async () => {
    const error = Object.assign(new Error("Cannot read output directory"), { code: "EACCES" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
    download = async (child, tempDir) => {
      await fs.writeFile(path.join(tempDir, "video.part"), "partial");
      child.emit("close", 0);
    };

    await expect(prepareDownload(request)).rejects.toBe(error);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it.each(["running", "completed"])("removes the directory when the %s progress callback throws", async (stage) => {
    const error = new Error("Progress callback failed");
    download = async (child, tempDir) => {
      const filePath = path.join(tempDir, "video.mp4");
      await fs.writeFile(filePath, "media");
      child.stdout.write(`${filePath}\n`);
      child.emit("close", 0);
    };

    await expect(prepareDownload({
      ...request,
      progress: (currentStage) => {
        if (currentStage === stage) throw error;
      }
    })).rejects.toBe(error);
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });

  it.each([true, false])("keeps successful output until cleanup (printed path: %s)", async (printPath) => {
    download = async (child, tempDir) => {
      const filePath = path.join(tempDir, "video.mp4");
      await fs.writeFile(filePath, "media");
      if (printPath) child.stdout.write(`${filePath}\n`);
      child.emit("close", 0);
    };

    const result = await prepareDownload(request);
    expect(await fs.readFile(result.filePath, "utf8")).toBe("media");
    expect(result.downloadName).toBe("video.mp4");
    await result.cleanup();
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });
});
