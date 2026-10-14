import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import { markMemoryOutboxRecovery, type MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";

const empty = { claimed: 0, dispatched: 0, reconciling: 0, settled: 0, conflicts: 0, failed: 0 };
describe("own-phase tick recovery", () => {
  it.each(["record_write_result", "dispatch", "claim_dispatch", "claim_reconciliation", "recover_dispatch"] as const)(
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
});
