import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { runCommand } from "../src/utils/process";

it("cancels a real process tree, including a descendant that ignores SIGTERM", async () => {
  const controller = new AbortController();
  let descendantPid = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const descendant = `process.on('SIGTERM', () => {}); console.log('READY:' + process.pid); setInterval(() => {}, 1000);`;
  const parent = `const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
  const result = runCommand(process.execPath, ["-e", parent], {
    signal: controller.signal,
    onStdout: (chunk) => {
      const match = chunk.match(/READY:(\d+)/);
      if (match) { descendantPid = Number(match[1]); ready(); }
    }
  });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  try {
    await started;
    controller.abort();
    await rejected;
    let running = true;
    try {
      process.kill(descendantPid, 0);
      if (process.platform === "linux") {
        const status = await fs.readFile(`/proc/${descendantPid}/status`, "utf8");
        running = !/^State:\s+Z/m.test(status);
      }
    } catch (error) {
      if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      running = false;
    }
    expect(running).toBe(false);
  } finally {
    controller.abort();
    if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    await result.catch(() => undefined);
  }
}, 15000);

it("returns normal output and spawn failures from real processes", async () => {
  expect(await runCommand(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('detail'); process.exitCode = 2"]))
    .toEqual({ code: 2, stdout: "ok", stderr: "detail" });
  await expect(runCommand("ytdl-nonexistent-command-721b", [])).rejects.toMatchObject({ code: "ENOENT" });
});
