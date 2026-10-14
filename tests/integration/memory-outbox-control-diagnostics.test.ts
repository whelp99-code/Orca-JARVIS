import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });
const ready = () => new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });
const state = (f: OutboxFixture) => new ControlPlane(f.database.authority).get(f.commandId)?.state;
async function terminalPair() {
  const first = await outboxFixture({ reader: ready() });
  fixtures.push(first);
  const second = await outboxFixture({ database: first.database, suffix: "-second", reader: ready() });
  const items = [];
  for (const f of [first, second]) {
    const claim = claimAction(f); const saga = f.service.enqueue(claim);
    expect((await f.service.runOnce("terminal-seed", 1)).settled).toBe(1);
    items.push({ f, claim, id: saga.outbox_id });
  }
  for (const { f, claim } of items) new ControlPlane(f.database.authority).settle(f.commandId, claim.fence, {
    state: "uncertain", effect_type: "memory.outbox.reconciling", payload: {},
    failure_code: "MEMORY_OUTBOX_RECONCILING",
  }, f.clock.now);
  items.sort((a, b) => a.id < b.id ? -1 : 1);
  const a = items[0]; const b = items[1];
  if (a === undefined || b === undefined) throw new Error("fixture pair unavailable");
  return { a, b, service: first.service };
}

describe("command-correlated outbox control diagnostics", () => {
  it("retains A's control failure when the bounded cursor recovers B before revisiting A", async () => {
    const { a, b, service } = await terminalPair();
    a.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?")
      .run(a.f.commandId);
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await service.runOnce("control-correlated", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toEqual([{ phase: "control_reconciliation",
        error_code: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED", cause_code: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" }]);

      tick.tick(); await tick.drain();

      expect(cycles.at(-1)?.commands_reconciled).toBe(1);
      expect(state(b.f)).toBe("completed");
      expect(state(a.f)).toBe("uncertain");
      expect(logs).toHaveLength(1);
      expect(cycles.at(-1)?.failure).toBe(logs[0]);
      a.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=? WHERE request_id=?")
        .run(a.claim.fence, a.f.commandId);
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(state(a.f)).toBe("completed");
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
      expect(a.f.writer.calls).toHaveLength(1); expect(b.f.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });

  it("recovers from the failed command's externally committed control proof on an idle tick", async () => {
    const { a, b, service } = await terminalPair();
    a.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?")
      .run(a.f.commandId);
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await service.runOnce("idle-control-owner", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      a.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=? WHERE request_id=?")
        .run(a.claim.fence, a.f.commandId);
      const independent = new ControlPlane(a.f.database.authority);
      expect(independent.reconcileMemoryOutbox(a.id, a.f.clock.now)).toBe(true);
      expect(independent.reconcileMemoryOutbox(b.id, b.f.clock.now)).toBe(true);

      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();

      expect(state(a.f)).toBe("completed");
      expect(cycles.at(-1)?.commands_reconciled).toBe(0);
      expect(cycles.at(-1)?.settled).toBe(0);
      expect(cycles.at(-1)?.dispatched).toBe(0);
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
      expect(a.f.writer.calls).toHaveLength(1); expect(b.f.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });

  it("retains the failed command's diagnostic when the control batch commit rolls back", async () => {
    const { a, service } = await terminalPair();
    const db = a.f.database.authority.db;
    db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?").run(a.f.commandId);
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await service.runOnce("rollback-control-owner", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      db.prepare("UPDATE control_command_requests SET lease_fence=? WHERE request_id=?").run(a.claim.fence, a.f.commandId);
      db.exec("DELETE FROM memory_outbox_control_cursor");
      db.exec(`CREATE TRIGGER diagnostic_cursor_failure BEFORE INSERT ON memory_outbox_control_cursor
        BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END`);

      tick.tick(); await tick.drain();

      expect(state(a.f)).toBe("uncertain");
      expect(cycles.at(-1)?.commands_reconciled).toBe(0);
      expect(cycles.at(-1)?.control_error).toBe("MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED");
      expect(cycles.at(-1)?.failure).toBe(logs[0]);
      expect(logs).toHaveLength(1);
      db.exec("DROP TRIGGER diagnostic_cursor_failure");
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(state(a.f)).toBe("completed");
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
      expect(a.f.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });
});
