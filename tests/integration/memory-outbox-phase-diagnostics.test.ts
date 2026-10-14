import { afterEach, describe, expect, it, vi } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import { memoryOutboxRecovered, type MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });
const ready = () => new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });
async function pair() {
  const a = await outboxFixture({ reader: ready() }); fixtures.push(a);
  const b = await outboxFixture({ database: a.database, suffix: "-other-phase", reader: ready() });
  return { a, b };
}

describe("own-phase outbox diagnostic recovery", () => {
  it.each(["dispatch", "provider_observation"] as const)("clears repeated %s rejections with the same cause", async phase => {
    const a = await outboxFixture({ reader: ready(), deadline: 60_000 }); fixtures.push(a);
    const id = a.service.enqueue(claimAction(a)).outbox_id;
    const rejection = () => { throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL"); };
    const fault = phase === "dispatch" ? vi.spyOn(MemoryOutboxStore.prototype, "markDispatch").mockImplementation(rejection)
      : vi.spyOn(a.reader, "recentChanges").mockImplementation(rejection);
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof a.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await a.service.runOnce("same-cause-owner", 1); cycles.push(cycle); return cycle;
    }, value => logs.push(value));
    try {
      tick.tick(); await tick.drain();
      a.clock.now = new Date(a.clock.now.getTime() + 10_001);
      tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase })]);
      const shown = tick["lastFailure"];
      fault.mockRestore();
      a.clock.now = new Date(a.clock.now.getTime() + 10_001);

      tick.tick(); await tick.drain(); const recovered = cycles.at(-1);
      tick.tick(); await tick.drain();

      expect(a.service.get(id)?.state).toBe("settled");
      expect(a.writer.calls).toHaveLength(1);
      expect(memoryOutboxRecovered(recovered ?? {}, shown)).toBe(true);
      expect(logs).toEqual([expect.objectContaining({ phase }), null]);
    } finally { await tick.close(); }
  });

  it.each(["record_write_result", "dispatch"] as const)("retains %s for leased A while B completes", async phase => {
    const { a, b } = await pair();
    const queued = a.service.enqueue(claimAction(a));
    const target = phase === "record_write_result" ? "recordResult" : "markDispatch";
    const original = MemoryOutboxStore.prototype[target];
    const fault = vi.spyOn(MemoryOutboxStore.prototype, target).mockImplementation(function (this: MemoryOutboxStore, ...args) {
      const id = typeof args[0] === "string" ? args[0] : args[0].saga.outbox_id;
      if (id === queued.outbox_id) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL");
      return Reflect.apply(original, this, args);
    });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof a.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await a.service.runOnce("phase-owner", 1); cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase })]);
      const other = a.service.enqueue(claimAction(b));
      tick.tick(); await tick.drain();
      expect(a.service.get(other.outbox_id)?.state).toBe("settled");
      expect(a.service.get(queued.outbox_id)?.state).toBe(phase === "dispatch" ? "claimed" : "dispatching");
      expect(logs).toHaveLength(1);
      fault.mockRestore();
      a.clock.now = new Date(a.clock.now.getTime() + 10_001);
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(a.service.get(queued.outbox_id)?.state).toBe("settled");
      expect(logs).toEqual([expect.objectContaining({ phase }), null]);
      expect(a.writer.calls).toHaveLength(2);
      expect(cycles.at(-1)?.failure).toBeUndefined();
    } finally { await tick.close(); }
  });

  it.each(["claim_dispatch", "claim_reconciliation", "recover_dispatch"] as const)("requires %s's own successful retry", async phase => {
    const { a, b } = await pair();
    const claim = claimAction(b); const queued = b.service.enqueue(claim);
    const missing = { kind: "current" as const, checked_at: b.clock.now.toISOString(), evidence: [] };
    const recent = vi.spyOn(b.reader, "recentChanges").mockResolvedValue(missing);
    const page = vi.spyOn(b.reader, "readPage").mockResolvedValue(missing);
    expect((await b.service.runOnce("other-seed", 1)).dispatched).toBe(1);
    expect(b.service.get(queued.outbox_id)?.state).toBe("reconciling");
    recent.mockRestore(); page.mockRestore();
    const method = phase === "claim_reconciliation" ? "claimReconcile"
      : phase === "recover_dispatch" ? "recoverDispatching" : "claimDispatch";
    const fault = vi.spyOn(MemoryOutboxStore.prototype, method).mockImplementationOnce(() => {
      throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL");
    });
    const logs: (MemoryOutboxFailure | null)[] = [];
    let index = 0;
    const tick = new MemoryOutboxTick(() => {
      if (index++ === 0) return phase === "claim_reconciliation" ? a.service.reconcileOnce("claim-owner", 1) : a.service.runOnce("claim-owner", 1);
      if (index === 2) return phase === "claim_reconciliation" ? b.service.reconcileOnce("other-owner", 1) : a.service.reconcileOnce("other-phase", 1);
      return phase === "claim_reconciliation" ? a.service.reconcileOnce("claim-owner", 1) : a.service.runOnce("claim-owner", 1);
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(b.service.get(queued.outbox_id)?.state).toBe("settled");
      expect(logs).toEqual([expect.objectContaining({ phase })]);
      fault.mockRestore();
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase }), null]);
      expect(b.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });
});
