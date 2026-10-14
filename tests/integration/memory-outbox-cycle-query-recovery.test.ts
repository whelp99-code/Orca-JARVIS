import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });
const ready = () => new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });

describe("own diagnostic query and current control cause", () => {
  it("clears a failed query after its own empty successful retry", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const id = f.service.enqueue(claimAction(f)).outbox_id;
    const writer = vi.spyOn(f.writer, "write").mockImplementation(async () => {
      f.writer.calls.push(f.request); throw new Error("PRIVATE_SENTINEL");
    });
    expect((await f.service.runOnce("query-seed", 1)).failure?.phase).toBe("provider_write");
    writer.mockRestore();
    const independent = await outboxFixture({ database: f.database, suffix: "-query-other", reader: ready() });
    expect((await independent.service.reconcileOnce("query-independent", 1)).settled).toBe(1);
    const db = f.database.authority.db; const prepare = db.prepare.bind(db);
    let fail = true;
    vi.spyOn(db, "prepare").mockImplementation((...args) => {
      if (fail && args[0].startsWith("WITH faults")) { fail = false; throw new Error("PRIVATE_SENTINEL"); }
      return prepare(...args);
    });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof f.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await f.service.runOnce("query-owner", 1); cycles.push(cycle); return cycle;
    }, value => logs.push(value));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase: "cycle" })]);

      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();

      expect(f.service.get(id)?.state).toBe("settled");
      expect(cycles.at(-1)?.commands_reconciled).toBe(0);
      expect(cycles.at(-1)?.settled).toBe(0);
      expect(cycles.at(-1)?.dispatched).toBe(0);
      expect(logs).toEqual([expect.objectContaining({ phase: "cycle" }), null]);
      expect(f.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });

  it("reports the new approved cause before the same control command recovers", async () => {
    const f = await outboxFixture({ reader: ready() }); fixtures.push(f);
    const claim = claimAction(f); const id = f.service.enqueue(claim).outbox_id;
    expect((await f.service.runOnce("cause-seed", 1)).settled).toBe(1);
    const control = new ControlPlane(f.database.authority);
    control.settle(f.commandId, claim.fence, { state: "uncertain", effect_type: "memory.outbox.reconciling",
      payload: {}, failure_code: "MEMORY_OUTBOX_RECONCILING" }, f.clock.now);
    let cause = "MEMORY_OUTBOX_STALE_FENCE";
    const retry = vi.spyOn(ControlPlane.prototype, "reconcileMemoryOutbox").mockImplementation(() => {
      throw new JarvisError(cause, "PRIVATE_SENTINEL");
    });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const tick = new MemoryOutboxTick(() => f.service.runOnce("cause-owner", 1), value => logs.push(value));
    try {
      tick.tick(); await tick.drain();
      cause = "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID";

      tick.tick(); await tick.drain();

      expect(logs).toEqual([
        expect.objectContaining({ cause_code: "MEMORY_OUTBOX_STALE_FENCE" }),
        expect.objectContaining({ cause_code: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" }),
      ]);
      retry.mockRestore();
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs.at(-1)).toBeNull();
      expect(logs).toHaveLength(3);
      expect(control.get(f.commandId)?.state).toBe("completed");
      expect(f.service.get(id)?.state).toBe("settled");
      expect(f.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });
});
