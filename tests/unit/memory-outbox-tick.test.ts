import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { markMemoryOutboxRecovery, memoryOutboxFailure, memoryOutboxLog, tagMemoryOutboxFailure,
  type MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";

const empty = { claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0 };
describe("bounded memory outbox tick", () => {
  it("requires the reported diagnostic's own proof even when another retired fault has identical fields", async () => {
    const fault = () => memoryOutboxFailure(tagMemoryOutboxFailure("provider_observation", new JarvisError("MEMORY_OUTBOX_STALE_FENCE")));
    const a = fault(); const b = fault();
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockResolvedValueOnce({ ...empty, failure: b })
      .mockResolvedValueOnce(markMemoryOutboxRecovery({ ...empty }, [a]))
      .mockResolvedValueOnce(markMemoryOutboxRecovery({ ...empty }, [b]))
      .mockResolvedValueOnce(empty);
    const tick = new MemoryOutboxTick(cycle, failure => logs.push(failure));
    tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
    expect(logs).toEqual([b]);

    tick.tick(); await tick.drain(); tick.tick(); await tick.close();

    expect(logs).toEqual([b, null]);
  });
  it.each(["reconciling", "dispatched", "commands_reconciled"] as const)(
    "retains a provider write failure through %s without terminal evidence", async progress => {
      const logs: unknown[] = [];
      const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
        .mockRejectedValueOnce(tagMemoryOutboxFailure("provider_write", new Error("PRIVATE_SENTINEL")))
        .mockResolvedValueOnce({ ...empty, [progress]: 1 });
      const tick = new MemoryOutboxTick(cycle, failure => logs.push(memoryOutboxLog(failure)));

      tick.tick(); await tick.drain(); tick.tick(); await tick.close();

      expect(logs).toEqual([{ component: "memory.outbox", phase: "provider_write",
        error_code: "MEMORY_OUTBOX_PROVIDER_WRITE_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
    });
  it.each(["settled", "conflicts"] as const)("recovers a provider write only after %s evidence", async terminal => {
    const logs: unknown[] = [];
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockRejectedValueOnce(tagMemoryOutboxFailure("provider_write", new Error("PRIVATE_SENTINEL")))
      .mockResolvedValueOnce({ ...empty, reconciling: 1 })
      .mockResolvedValueOnce({ ...empty, [terminal]: 1 })
      .mockResolvedValueOnce(empty);
    const tick = new MemoryOutboxTick(cycle, failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
    expect(logs).toHaveLength(1);

    tick.tick(); await tick.drain(); tick.tick(); await tick.close();

    expect(logs).toEqual([
      { component: "memory.outbox", phase: "provider_write",
        error_code: "MEMORY_OUTBOX_PROVIDER_WRITE_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" },
      { component: "memory.outbox", phase: null, error_code: null, cause_code: null },
    ]);
  });
  it.each(["getter", "prototype", "revoked"])("reports a throwing %s without rejecting the tick", async kind => {
    const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    Object.defineProperty(error, "code", { get: () => { throw new Error("PRIVATE_SENTINEL"); } });
    let thrown: unknown = error;
    if (kind === "prototype") thrown = new Proxy(error, {
      getPrototypeOf() { throw new Error("PRIVATE_SENTINEL"); },
    });
    if (kind === "revoked") {
      const { proxy, revoke } = Proxy.revocable(error, {});
      revoke(); thrown = proxy;
    }
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(async () => {
      throw tagMemoryOutboxFailure("provider_observation", thrown);
    }, failure => logs.push(memoryOutboxLog(failure)));

    tick.tick();
    await tick.close();

    expect(logs).toEqual([{ component: "memory.outbox", phase: "provider_observation",
      error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
  });

  it("publishes recovered command changes and reports control proof errors", async () => {
    const report = vi.fn(); const changes = vi.fn();
    const failure = memoryOutboxFailure(tagMemoryOutboxFailure("control_reconciliation",
      new JarvisError("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID")));
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockResolvedValueOnce({ ...empty, failure, control_error: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" })
      .mockResolvedValueOnce(markMemoryOutboxRecovery({ ...empty, commands_reconciled: 1 }, [failure]));
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
  it("clears a prior failure after reconciling-only progress and ignores that progress for changes", async () => {
    const report = vi.fn(); const changes = vi.fn();
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
      .mockRejectedValueOnce(tagMemoryOutboxFailure("provider_observation", new JarvisError("MEMORY_READ_FENCE_KEY_UNAVAILABLE")))
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ ...empty, reconciling: 1 });
    const tick = new MemoryOutboxTick(cycle, report, changes);
    for (let index = 0; index < 3; index++) { tick.tick(); await tick.drain(); }
    await tick.close();
    expect(report.mock.calls).toEqual([
      [{ phase: "provider_observation", error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED",
        cause_code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" }],
      [null],
    ]);
    expect(changes).not.toHaveBeenCalled();
  });
  it.each(["PRIVATE_SENTINEL /qa/private/path", undefined, null, false, 42, 1n, Symbol("PRIVATE_SENTINEL")])(
    "attributes a primitive throw to the supplied phase without retaining it (%#)", async marker => {
      const tagged = tagMemoryOutboxFailure("provider_observation", marker);
      expect(tagged).toBeInstanceOf(Error);
      expect(tagged).not.toBeInstanceOf(JarvisError);
      expect(tagged).not.toBe(marker);
      expect(tagMemoryOutboxFailure("settlement", marker)).not.toBe(tagged);
      if (!(tagged instanceof Error)) return;
      expect(tagged.message).toBe("MEMORY_OUTBOX_UNCLASSIFIED_ERROR");
      expect(tagged.cause).toBeUndefined();
      const fn = () => undefined;
      expect(tagMemoryOutboxFailure("settlement", fn)).toBe(fn);
      const logs: unknown[] = [];
      const tick = new MemoryOutboxTick(async () => { throw tagged; }, failure => logs.push(memoryOutboxLog(failure)));
      tick.tick(); await tick.close();
      expect(logs).toEqual([{ component: "memory.outbox", phase: "provider_observation",
        error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
      expect(JSON.stringify(tagged)).not.toContain("PRIVATE_SENTINEL");
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
