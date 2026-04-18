import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
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

  const localCandidate = path.resolve(process.cwd(), "tools", "bin", command);
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

    const child = spawn(resolveExecutable(command), args, { stdio: ["ignore", "pipe", "pipe"] });
    const shouldEmitOutput = options.emitOutput ?? false;
    const prefix = options.logPrefix ? `[${options.logPrefix}] ` : `[${command}] `;
    let settled = false;

    const finishResolve = (value: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const handleAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1500);

      const error = new Error("Command execution aborted.");
      error.name = "AbortError";
      finishReject(error);
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });

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
      options.signal?.removeEventListener("abort", handleAbort);
      finishReject(error);
    });

    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", handleAbort);
      finishResolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const versionArgs = command === "ffmpeg" || command === "ffprobe" ? ["-version"] : ["--version"];
    const result = await runCommand(command, versionArgs);
    return result.code === 0;
  } catch {
    return false;
  }
}
