import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOwnedTempDirectory, collectOrphanTempDirectories } from "../src/services/tempDirectoryService";

const markerName = ".youtube-downloader-owner.json";
const now = Date.now();
const maxAgeMs = 60_000;
let root: string;
let deadPid: number;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "temp-recovery-test-"));
  deadPid = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function staleDirectory(kind: "job" | "cookies" = "job", patch: Record<string, unknown> = {}) {
  const directory = await createOwnedTempDirectory(root, kind);
  const markerPath = path.join(directory, markerName);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, pid: deadPid, createdAt: now - 2 * maxAgeMs, ...patch }));
  const old = new Date(now - 2 * maxAgeMs);
  await fs.utimes(markerPath, old, old);
  await fs.utimes(directory, old, old);
  return directory;
}

describe("startup temporary directory recovery", () => {
  it.skipIf(process.platform !== "linux")("removes stale owned job and cookie directories after the owner exits", async () => {
    const job = await staleDirectory();
    const cookies = await staleDirectory("cookies");
    expect(await collectOrphanTempDirectories(root, maxAgeMs, now)).toBe(2);
    await expect(fs.stat(job)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(cookies)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves fresh directories and old directories with a live owner", async () => {
    const fresh = await createOwnedTempDirectory(root, "job");
    const active = await staleDirectory("cookies", { pid: process.pid });
    const recentDirectory = await staleDirectory();
    await fs.utimes(recentDirectory, new Date(now), new Date(now));
    const recentMarker = await staleDirectory();
    await fs.utimes(path.join(recentMarker, markerName), new Date(now), new Date(now));
    expect(await collectOrphanTempDirectories(root, maxAgeMs, now)).toBe(0);
    for (const directory of [fresh, active, recentDirectory, recentMarker]) expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it("preserves unmarked, malformed, foreign-scope, future-dated and unrelated directories", async () => {
    await fs.mkdir(path.join(root, "job-legacy"));
    const foreign = await staleDirectory("job", { scope: "another-machine-or-pid-namespace" });
    const future = await staleDirectory("job", { createdAt: now + maxAgeMs });
    const invalidPid = await staleDirectory("job", { pid: 0 });
    const mismatchedName = await staleDirectory("cookies", { kind: "job" });
    const malformed = await staleDirectory();
    await fs.writeFile(path.join(malformed, markerName), "not-json");
    const unrelated = path.join(root, "personal-files");
    await fs.rename(await staleDirectory(), unrelated);
    expect(await collectOrphanTempDirectories(root, maxAgeMs, now)).toBe(0);
    for (const directory of [foreign, future, invalidPid, mismatchedName, malformed, unrelated]) expect((await fs.stat(directory)).isDirectory()).toBe(true);
    expect(await fs.readdir(root)).toContain("job-legacy");
  });

  it("does not follow directory or ownership marker symlinks", async () => {
    const owned = await staleDirectory();
    const marker = path.join(owned, markerName);
    const externalMarker = path.join(root, "external-marker");
    await fs.rename(marker, externalMarker);
    await fs.symlink(externalMarker, marker);
    const old = new Date(now - 2 * maxAgeMs);
    await fs.utimes(owned, old, old);
    const link = path.join(root, "job-12345678-1234-1234-1234-123456789abc");
    await fs.symlink(owned, link);
    expect(await collectOrphanTempDirectories(root, maxAgeMs, now)).toBe(0);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
  });
});
