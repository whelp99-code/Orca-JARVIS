import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CYCLE_READY_TYPE, waitForCycleReady } from "../../src/personal-os-cycle-ready.js";

afterEach(() => vi.useRealTimers());
function child() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as ChildProcess;
}
function assertClean(process: ChildProcess) {
  for (const event of ["message", "error", "exit"]) expect(process.listenerCount(event)).toBe(0);
}
describe("staged cycle readiness", () => {
  it("requires a ready message for this socket and releases every owned listener", async () => {
    const process = child(); let ready = false;
    const waiting = waitForCycleReady(process, "/fixture/c.sock", 1000).then(() => { ready = true; });
    for (const value of [null, "ready", { type: CYCLE_READY_TYPE, socket_path: "/other/c.sock" }]) process.emit("message", value);
    await Promise.resolve(); expect(ready).toBe(false);
    process.emit("message", { type: CYCLE_READY_TYPE, socket_path: "/fixture/c.sock" });
    await waiting; expect(ready).toBe(true); assertClean(process);
  });
  it.each(["error", "exit"])("fails immediately on child %s", async event => {
    const process = child(); const failed = expect(waitForCycleReady(process, "/fixture/c.sock", 1000)).rejects.toThrow("E_PROCESS_STRESS");
    process.emit(event, event === "error" ? new Error("private child error") : 1);
    await failed; assertClean(process);
  });
  it("cleans up on timeout", async () => {
    vi.useFakeTimers(); const process = child();
    const failed = expect(waitForCycleReady(process, "/fixture/c.sock", 1000)).rejects.toThrow("E_PROCESS_STRESS");
    await vi.advanceTimersByTimeAsync(1000); await failed; assertClean(process); expect(vi.getTimerCount()).toBe(0);
  });
});
