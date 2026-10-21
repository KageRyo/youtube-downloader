import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const markerName = ".youtube-downloader-owner.json";
const directoryPattern = /^(job|cookies)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
type DirectoryKind = "job" | "cookies";

// A PID is meaningful only in the same kernel boot and PID namespace. Unsupported
// platforms or inaccessible identity files disable collection, never ownership.
async function processScope(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [boot, namespace] = await Promise.all([
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      fs.readlink("/proc/self/ns/pid")
    ]);
    if (!/^[0-9a-f-]{36}$/.test(boot.trim()) || !/^pid:\[\d+\]$/.test(namespace)) return undefined;
    return `${boot.trim()}:${namespace}`;
  } catch { return undefined; }
}

export async function createOwnedTempDirectory(root: string, kind: DirectoryKind, id: string = crypto.randomUUID()): Promise<string> {
  const name = `${kind}-${id}`;
  if (!directoryPattern.test(name)) throw new Error("Invalid temporary directory identity.");
  await fs.mkdir(root, { recursive: true });
  const directory = path.join(root, name);
  // Exclusive creation prevents taking ownership of any pre-existing path.
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(directory, markerName), JSON.stringify({
      version: 1, kind, id, pid: process.pid, scope: await processScope(), createdAt: Date.now()
    }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

function ownerIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function collectOrphanTempDirectories(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(now)) throw new Error("Invalid temporary directory collection age.");
  const scope = await processScope();
  if (!scope) return 0;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const match = directoryPattern.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const directory = path.join(root, entry.name);
    try {
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.mtimeMs > now - maxAgeMs) continue;
      // O_NOFOLLOW rejects a marker symlink, including a replacement after listing.
      const markerFile = await fs.open(path.join(directory, markerName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let marker;
      try {
        const stat = await markerFile.stat();
        if (!stat.isFile() || stat.size > 4096 || stat.mtimeMs > now - maxAgeMs) continue;
        marker = JSON.parse(await markerFile.readFile("utf8"));
      } finally { await markerFile.close(); }
      if (!marker || marker.version !== 1 || marker.kind !== match[1] || marker.id !== match[2] || marker.scope !== scope ||
          !Number.isSafeInteger(marker.pid) || marker.pid <= 0 ||
          !Number.isSafeInteger(marker.createdAt) || marker.createdAt <= 0 || marker.createdAt > now - maxAgeMs ||
          !ownerIsDead(marker.pid)) continue;
      const current = await fs.lstat(directory);
      if (!current.isDirectory() || current.dev !== directoryStat.dev || current.ino !== directoryStat.ino ||
          current.mtimeMs !== directoryStat.mtimeMs) continue;
      await fs.rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Missing, inaccessible, malformed or concurrently changed paths are ambiguous.
      // Leave them in place rather than guessing ownership or liveness.
    }
  }
  return removed;
}
