import { describe, expect, it, vi } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, signCommandApproval, type AuthorityDb } from "../../src/index.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { claimAction, outboxFixture, OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { localKey } from "../helpers.js";

const AFTER = new Date("2026-09-29T06:00:00.000Z");

async function reconciling(code: string) {
  const fixture = await outboxFixture();
  fixture.writer.write = () => Promise.resolve({ kind: "uncertain", code });
  const action = claimAction(fixture);
  const queued = fixture.service.enqueue(action);
  await fixture.service.runOnce("fixture-worker", 1);
  const linked = fixture.database.authority.db.prepare(
    "SELECT state,lease_fence FROM control_command_requests WHERE request_id=?",
  ).get(action.request_id) as { state: string; lease_fence: number };
  if (linked.state === "claimed") {
    new ControlPlane(fixture.database.authority).settle(action.request_id, linked.lease_fence, {
      state: "uncertain", effect_type: "memory.outbox.reconciling", payload: { outbox_id: queued.outbox_id },
      failure_code: "RECONCILE_TIMEOUT" }, new Date(OUTBOX_NOW.getTime() + 1000));
  }
  return { fixture, outboxId: queued.outbox_id, requestId: action.request_id };
}

function stageAbandon(db: AuthorityDb, outboxId: string): string {
  const control = new ControlPlane(db);
  const staged = control.stage({ schema_version: 1, request_id: `abandon-${outboxId.slice(-12)}`,
    action: "memory.outbox.abandon-not-delivered", action_level: 3,
    target: { outbox_id: outboxId }, args: { schema_version: 1, outbox_id: outboxId }, reversible: false,
    requested_by: "principal:owner", requested_at: AFTER.toISOString(),
    expires_at: "2026-09-29T06:10:00.000Z", nonce: `nonce-${outboxId.slice(-12)}` }, AFTER);
  control.decide(signCommandApproval({ schema_version: 1, receipt_id: `approve-${outboxId.slice(-12)}`,
    request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: AFTER.toISOString(),
    not_before: AFTER.toISOString(), expires_at: staged.expires_at, nonce: `approval-${outboxId.slice(-12)}`,
    max_uses: 1, status: "issued" }, localKey(db)), AFTER);
  return staged.request_id;
}

describe("abandon an expired outbox that never reached Second Brain", () => {
  it("retires a retained observer failure after signed abandonment even while the row stays reconciling", async () => {
    const { fixture, outboxId } = await reconciling("SECOND_BRAIN_DISCOVERY_FAILED");
    const db = fixture.database.authority;
    vi.spyOn(fixture.reader, "recentChanges").mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof fixture.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await fixture.service.runOnce("abandon-diagnostic-owner", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase: "provider_observation" })]);
      expect(await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => AFTER).execute(
        stageAbandon(db, outboxId), "owner-worker", AFTER)).toMatchObject({ state: "completed" });
      fixture.clock.now = AFTER;

      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();

      expect(fixture.service.get(outboxId)?.state).toBe("reconciling");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_outbox_not_delivered WHERE outbox_id=?").get(outboxId))
        .toEqual({ count: 1 });
      expect(cycles.at(-1)?.claimed).toBe(0);
      expect(logs).toEqual([expect.objectContaining({ phase: "provider_observation" }), null]);
    } finally { await tick.close(); vi.restoreAllMocks(); closeMemoryDatabase(fixture.database); }
  });
  it("closes a discovery failure and the linked command, then stops reconcile claims", async () => {
    const { fixture, outboxId, requestId } = await reconciling("SECOND_BRAIN_DISCOVERY_FAILED");
    const db = fixture.database.authority;
    try {
      const execution = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => AFTER).execute(
        stageAbandon(db, outboxId), "owner-worker", AFTER);
      expect(execution).toMatchObject({ state: "completed", result: { outbox_id: outboxId,
        state: "abandoned_not_delivered" } });
      expect(db.db.prepare("SELECT state,failure_code FROM control_command_requests WHERE request_id=?").get(requestId))
        .toEqual({ state: "failed", failure_code: "ABANDONED_NOT_DELIVERED" });
      expect((db.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_outbox_not_delivered_events WHERE outbox_id=?",
      ).get(outboxId) as { count: number }).count).toBe(1);
      expect(db.db.prepare(
        `SELECT outbox_id FROM memory_outbox WHERE state='reconciling'
         AND outbox_id NOT IN (SELECT outbox_id FROM memory_outbox_not_delivered)`,
      ).all()).toEqual([]);
    } finally { closeMemoryDatabase(fixture.database); }
  });

  it("refuses an attempt that may already have reached the provider", async () => {
    const { fixture, outboxId } = await reconciling("MEMORY_OUTBOX_WRITE_FAILED");
    const db = fixture.database.authority;
    try {
      const execution = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => AFTER).execute(
        stageAbandon(db, outboxId), "owner-worker", AFTER);
      expect(execution).toMatchObject({ state: "failed", failure_code: "MEMORY_OUTBOX_ABANDON_REFUSED" });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_outbox_not_delivered").get()).toEqual({ count: 0 });
    } finally { closeMemoryDatabase(fixture.database); }
  });
});
