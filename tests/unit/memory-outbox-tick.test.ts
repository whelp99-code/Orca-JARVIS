import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";

const empty = { claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0 };
describe("bounded memory outbox tick", () => {
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
      .mockResolvedValueOnce(empty);
    const tick = new MemoryOutboxTick(cycle, report, changes);
    for (let index = 0; index < 3; index++) {
      tick.tick();
      await tick.drain();
    }
    await tick.close();
    expect(report.mock.calls).toEqual([["MEMORY_OUTBOX_CYCLE_FAILED"], [null]]);
    expect(changes).not.toHaveBeenCalled();
  });
});
