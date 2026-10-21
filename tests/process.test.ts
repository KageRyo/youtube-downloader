import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { runCommand } from "../src/utils/process";

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}

describe("command cancellation", () => {
  let child: Child;
  beforeEach(() => {
    vi.useFakeTimers();
    child = new Child();
    mocks.spawn.mockReset().mockReturnValue(child);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("waits for close before rejecting abort and clears listeners and escalation", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let settled = false;
    const result = runCommand("fixture", [], { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    void result.catch(() => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await assertion;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates once when graceful termination is ignored, then waits for close", async () => {
    const controller = new AbortController();
    const result = runCommand("fixture", [], { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1500);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    child.emit("close", null, "SIGKILL");
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves spawn failures and leaves no abort listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const error = new Error("ENOENT");
    const result = runCommand("fixture", [], { signal: controller.signal });
    const assertion = expect(result).rejects.toBe(error);
    child.emit("error", error);
    child.emit("close", -2);
    await assertion;
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spawn a command for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand("fixture", [], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe("bounded command diagnostics", () => {
  it("keeps byte-bounded tails while forwarding all progress chunks", async () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    let receivedBytes = 0;
    const result = runCommand("fixture", [], { onStdout: (chunk) => { receivedBytes += Buffer.byteLength(chunk); } });
    child.stdout.write(Buffer.alloc(1024 * 1024, "x"));
    child.stdout.write("FINAL OUTPUT");
    child.stderr.write(Buffer.alloc(1024 * 1024, "e"));
    child.stderr.write("Useful final failure");
    child.emit("close", 1);
    const output = await result;
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(output.stdout.endsWith("FINAL OUTPUT")).toBe(true);
    expect(output.stderr.endsWith("Useful final failure")).toBe(true);
    expect(receivedBytes).toBe(1024 * 1024 + 12);
  });

  it("preserves UTF-8 across chunks and starts the retained tail at a character boundary", async () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    const result = runCommand("fixture", []);
    const bytes = Buffer.from("音🎵".repeat(20000));
    child.stdout.write(bytes.subarray(0, 5));
    child.stdout.write(bytes.subarray(5));
    child.emit("close", 0);
    const output = await result;
    expect(output.stdout).not.toContain("�");
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(output.stdout.endsWith("音🎵")).toBe(true);
  });
});
