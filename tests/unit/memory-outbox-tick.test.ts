import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { memoryOutboxLog, tagMemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";

const empty = { claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0 };
describe("bounded memory outbox tick", () => {
  it("publishes recovered command changes and reports control proof errors", async () => {
    const report = vi.fn(); const changes = vi.fn();
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockResolvedValueOnce({ ...empty, control_error: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" })
      .mockResolvedValueOnce({ ...empty, commands_reconciled: 1 });
    const tick = new MemoryOutboxTick(cycle, report, changes);
    tick.tick(); await tick.drain(); tick.tick(); await tick.close();
    expect(report.mock.calls).toEqual([[{ phase: "control_reconciliation",
      error_code: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED", cause_code: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" }], [null]]);
    expect(changes).toHaveBeenCalledTimes(1);
  });
  it("coalesces overlapping ticks and drains a cycle before close returns", async () => {
    const deferred = Promise.withResolvers<MemoryOutboxCycleResult>();
    const cycle = vi.fn(() => deferred.promise); const changes = vi.fn();
    const tick = new MemoryOutboxTick(cycle, vi.fn(), changes);
    tick.tick(); tick.tick(); await Promise.resolve();
    expect(cycle).toHaveBeenCalledTimes(1);
    let closed = false; const closing = tick.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    deferred.resolve({ ...empty, settled: 1 }); await closing;
    expect(changes).toHaveBeenCalledTimes(1);
    tick.tick(); await Promise.resolve(); expect(cycle).toHaveBeenCalledTimes(1);
  });
  it("reports only changed failures and recovery and not idle cycles", async () => {
    const report = vi.fn(); const changes = vi.fn();
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockRejectedValueOnce(new Error("private detail"))
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce({ ...empty, settled: 1 });
    const tick = new MemoryOutboxTick(cycle, report, changes);
    for (let index = 0; index < 3; index++) {
      tick.tick();
      await tick.drain();
    }
    await tick.close();
    expect(report.mock.calls).toEqual([[{ phase: "cycle", error_code: "MEMORY_OUTBOX_CYCLE_FAILED",
      cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }], [null]]);
    expect(changes).toHaveBeenCalledTimes(1);
  });
  it("keeps the same failure suppressed across idle lease cycles and emits a changed cause", async () => {
    const report = vi.fn();
    const failure = () => tagMemoryOutboxFailure("provider_observation", new JarvisError("MEMORY_READ_FENCE_KEY_UNAVAILABLE"));
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockRejectedValueOnce(failure()).mockResolvedValueOnce(empty).mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(tagMemoryOutboxFailure("provider_observation", new JarvisError("MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE")))
      .mockRejectedValueOnce(tagMemoryOutboxFailure("settlement", new JarvisError("MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE")))
      .mockResolvedValueOnce({ ...empty, settled: 1 });
    const tick = new MemoryOutboxTick(cycle, report);
    for (let index = 0; index < 6; index++) { tick.tick(); await tick.drain(); }
    await tick.close();
    expect(report.mock.calls).toEqual([
      [{ phase: "provider_observation", error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED",
        cause_code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" }],
      [{ phase: "provider_observation", error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED",
        cause_code: "MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE" }],
      [{ phase: "settlement", error_code: "MEMORY_OUTBOX_SETTLEMENT_FAILED",
        cause_code: "MEMORY_READ_FENCE_AUTHORITY_UNAVAILABLE" }],
      [null],
    ]);
  });
  it.each([
    new Error("PRIVATE_SENTINEL /qa/private/path"),
    { code: "MEMORY_OUTBOX_STALE_FENCE", message: "PRIVATE_SENTINEL /qa/private/path" },
    new JarvisError("/qa/private/path"),
    new JarvisError("X".repeat(65)),
  ])("never logs an untrusted error body or malformed code (%#)", async error => {
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(async () => { throw error; }, failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.close();
    expect(logs).toEqual([{ component: "memory.outbox", error_code: "MEMORY_OUTBOX_CYCLE_FAILED",
      phase: "cycle", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(logs)).not.toContain("/qa/private/path");
  });
  it("logs only a tagged phase and valid JarvisError code without replacing the exception", async () => {
    const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL /qa/private/path");
    expect(tagMemoryOutboxFailure("record_observation", error)).toBe(error);
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(async () => { throw error; }, failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.close();
    expect(logs).toEqual([{ component: "memory.outbox", error_code: "MEMORY_OUTBOX_RECORD_OBSERVATION_FAILED",
      phase: "record_observation", cause_code: "MEMORY_OUTBOX_STALE_FENCE" }]);
  });
});
