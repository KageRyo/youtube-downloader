import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./config/env";
import { getFfmpegLocation } from "./utils/ffmpeg";
import { resolveExecutable, runCommand } from "./utils/process";

async function main(): Promise<void> {
  let failures = 0;
  const report = (ok: boolean, message: string) => {
    console.log(`${ok ? "OK" : "FAIL"} ${message}`);
    if (!ok) failures += 1;
  };
  report(Number(process.versions.node.split(".")[0]) >= 22, `Node.js ${process.versions.node}; required: 22+ (CI: 22 and 24).`);
  const location = getFfmpegLocation();
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe"]) {
    const executable = tool === "yt-dlp" ? resolveExecutable(tool) : location
      ? path.join(location, `${tool}${process.platform === "win32" ? ".exe" : ""}`) : tool;
    try {
      const args = tool === "yt-dlp" ? ["--version"] : ["-version"];
      const result = await runCommand(executable, args, { preferLocal: false, signal: AbortSignal.timeout(5000) });
      report(result.code === 0, `${tool}: ${executable}; ${result.code === 0 ? result.stdout.split(/\r?\n/)[0] : "version check failed; reinstall the tool"}`);
      if (tool === "yt-dlp" && result.code === 0) {
        const help = await runCommand(executable, ["--help"], { preferLocal: false, signal: AbortSignal.timeout(5000) });
        report(help.code === 0 && ["--js-runtimes", "--remux-video", "--merge-output-format"].every((flag) => help.stdout.includes(flag)), "yt-dlp supports the app's JS runtime and MP4 flags; upgrade yt-dlp if this fails.");
      }
    } catch {
      report(false, `${tool}: not executable or timed out. Install yt-dlp in PATH/tools/bin and a complete ffmpeg/ffprobe pair in PATH or tools/bin.`);
    }
  }
  let probe: string | undefined;
  try {
    await fs.mkdir(env.tempRoot, { recursive: true });
    probe = await fs.mkdtemp(path.join(env.tempRoot, "doctor-"));
    await fs.writeFile(path.join(probe, "write-check"), "ok");
    const space = await fs.statfs(probe);
    report(space.bavail * space.bsize >= env.maxJobBytes, "Temporary storage is writable and has room for one configured job budget.");
  } catch {
    report(false, "Temporary storage is not writable; check DOWNLOADER_TMP_DIR and available disk space.");
  } finally {
    if (probe) await fs.rm(probe, { recursive: true, force: true });
  }
  report(env.maxJobBytes <= env.maxStorageBytes, "MAX_STORAGE_BYTES can reserve at least one MAX_JOB_BYTES job.");
  console.log("EJS: official yt-dlp executables bundle the solver. For pip installs use yt-dlp[default]. Offline checks cannot verify current YouTube access or challenges.");
  process.exitCode = failures > 0 ? 1 : 0;
}
void main().catch(() => { console.error("Dependency diagnostics failed."); process.exitCode = 1; });
