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
