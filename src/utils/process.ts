import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  preferLocal?: boolean;
  logPrefix?: string;
  emitOutput?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

function resolveExecutable(command: string): string {
  if (command.includes(path.sep)) {
    return command;
  }

  const fileName = process.platform === "win32" ? `${command}.exe` : command;
  const localCandidate = path.resolve(process.cwd(), "tools", "bin", fileName);
  if (fs.existsSync(localCandidate)) {
    return localCandidate;
  }

  return command;
}

function writePrefixedLine(stream: NodeJS.WriteStream, prefix: string, chunk: string): void {
  const lines = chunk.replace(/\r\n|\r/g, "\n").split("\n");

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    stream.write(`${prefix}${line}\n`);
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error("Command execution aborted before start.");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const child = spawn(options.preferLocal === false ? command : resolveExecutable(command), args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    const shouldEmitOutput = options.emitOutput ?? false;
    const prefix = options.logPrefix ? `[${options.logPrefix}] ` : `[${command}] `;
    let settled = false;
    let aborted = false;
    let closed = false;
    let terminationPending = false;
    let escalation: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishAbort = () => {
      if (!closed || terminationPending) return;
      const error = new Error("Command execution aborted.");
      error.name = "AbortError";
      finishReject(error);
    };
    const signalTree = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        child.kill(signal);
      }
    };
    const groupExists = () => {
      if (!child.pid || process.platform === "win32") return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const handleAbort = () => {
      if (aborted || settled) return;
      aborted = true;
      if (process.platform === "win32" && child.pid) {
        // taskkill terminates the full tree; child.kill alone leaves FFmpeg alive.
        terminationPending = true;
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => { child.kill("SIGKILL"); });
        killer.once("close", () => { terminationPending = false; finishAbort(); });
      } else {
        signalTree("SIGTERM");
        escalation = setTimeout(() => {
          signalTree("SIGKILL");
          terminationPending = false;
          finishAbort();
        }, 1500);
        terminationPending = true;
      }
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    // Abort may have happened while spawn was being called.
    if (options.signal?.aborted) handleAbort();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);

      if (shouldEmitOutput) {
        writePrefixedLine(process.stdout, prefix, text);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);

      if (shouldEmitOutput) {
        writePrefixedLine(process.stderr, prefix, text);
      }
    });

    child.on("error", (error) => {
      if (!aborted || !child.pid) finishReject(error);
    });

    child.on("close", (code) => {
      closed = true;
      if (aborted) {
        if (process.platform !== "win32" && !groupExists()) terminationPending = false;
        finishAbort();
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function isCommandAvailable(command: string, options: RunCommandOptions = {}): Promise<boolean> {
  try {
    const toolName = path.basename(command).replace(/\.exe$/i, "");
    const versionArgs = toolName === "ffmpeg" || toolName === "ffprobe" ? ["-version"] : ["--version"];
    const result = await runCommand(command, versionArgs, options);
    return result.code === 0;
  } catch {
    return false;
  }
}
