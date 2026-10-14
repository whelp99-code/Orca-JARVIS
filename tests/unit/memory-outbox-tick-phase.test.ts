import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import { markMemoryOutboxCycleRetry, markMemoryOutboxRecovery, type MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";

const empty = { claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0 };
describe("own-phase tick recovery", () => {
  it.each(["record_write_result", "dispatch", "claim_dispatch", "claim_reconciliation", "recover_dispatch", "control_reconciliation"] as const)(
    "does not recover %s from aggregate progress or a different failure's proof", async phase => {
      const failure: MemoryOutboxFailure = { phase, error_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR",
        cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" };
      const logs: (MemoryOutboxFailure | null)[] = [];
      const progress = { ...empty, dispatched: 1, reconciling: 1, settled: 1, commands_reconciled: 1 };
      const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>()
        .mockResolvedValueOnce({ ...empty, failure }).mockResolvedValueOnce(progress)
        .mockResolvedValueOnce(markMemoryOutboxRecovery(progress, [{ ...failure }]))
        .mockResolvedValueOnce(markMemoryOutboxRecovery(empty, [failure])).mockResolvedValueOnce(empty);
      const tick = new MemoryOutboxTick(cycle, value => logs.push(value));
      try {
        tick.tick(); await tick.drain(); tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
        expect(logs).toEqual([failure]);
        tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
        expect(logs).toEqual([failure, null]);
      } finally { await tick.close(); }
    });

  it("requires query-origin cycle proof while preserving generic cycle progress recovery", async () => {
    const query = markMemoryOutboxCycleRetry({ phase: "cycle", error_code: "MEMORY_OUTBOX_CYCLE_FAILED",
      cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" });
    const generic: MemoryOutboxFailure = { ...query };
    const progress = { ...empty, settled: 1 };
    const logs: (MemoryOutboxFailure | null)[] = [];
    const results = [{ ...empty, failure: query }, progress,
      markMemoryOutboxRecovery({ ...empty }, [{ ...query }]), markMemoryOutboxRecovery({ ...empty }, [query]),
      { ...empty, failure: generic }, progress];
    const cycle = vi.fn<() => Promise<MemoryOutboxCycleResult>>();
    for (const result of results) cycle.mockResolvedValueOnce(result);
    const tick = new MemoryOutboxTick(cycle, value => logs.push(value));
    try {
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([query]);
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([query, null, generic, null]);
    } finally { await tick.close(); }
  });
});
