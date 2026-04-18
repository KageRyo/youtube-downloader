import { spawn } from "node:child_process";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const result = await runCommand(command, ["--version"]);
    return result.code === 0;
  } catch {
    return false;
  }
}
