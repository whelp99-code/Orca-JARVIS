import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane } from "../../src/control-plane.js";
import { AuthorityDb } from "../../src/db.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { reconcileMemoryOutboxCommands } from "../../src/memory-outbox-control.js";
import { removeSuppressedRows } from "../../src/memory-compaction-sanitize.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, FixtureWriter, OUTBOX_ARTIFACT_DIGEST,
  outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });
async function fixture(options: Parameters<typeof outboxFixture>[0] = {}) {
  const f = await outboxFixture(options);
  if (!fixtures.some(existing => existing.database === f.database)) fixtures.push(f);
  return f;
}
const ready = () => new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });
const state = (f: OutboxFixture) => f.database.authority.db.prepare(
  "SELECT state,failure_code FROM control_command_requests WHERE request_id=?").get(f.commandId);
const effects = (f: OutboxFixture) => f.database.authority.db.prepare(
  "SELECT effect_type,payload_json FROM control_command_effects WHERE request_id=? ORDER BY created_at,effect_id")
  .all(f.commandId) as { effect_type: string; payload_json: string }[];
function uncertain(f: OutboxFixture, fence: number) {
  new ControlPlane(f.database.authority).settle(f.commandId, fence, { state: "uncertain",
    effect_type: "memory.outbox.reconciling", payload: {}, failure_code: "MEMORY_OUTBOX_RECONCILING" }, f.clock.now);
}
async function settledLive(options: Parameters<typeof outboxFixture>[0] = {}) {
  const f = await fixture({ reader: ready(), ...options }); const claim = claimAction(f);
  const saga = f.service.enqueue(claim);
  expect(await f.service.runOnce("initial-worker", 1)).toMatchObject({ settled: 1, commands_reconciled: 0 });
  return { f, claim, id: saga.outbox_id, control: new ControlPlane(f.database.authority) };
}

describe("memory completion projected to the original control command", () => {
  it("keeps an unrelated completed execution successful when the recovery cursor commit fails", async () => {
    const previous = await settledLive(); uncertain(previous.f, previous.claim.fence);
    const f = await fixture({ database: previous.f.database, suffix: "-cursor-fault", reader: ready() });
    f.database.authority.db.exec(`CREATE TRIGGER test_cursor_failure BEFORE INSERT ON memory_outbox_control_cursor
      BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END`);
    const executor = new ApprovedCommandExecutor(f.database.authority, undefined, undefined, {}, () => f.clock.now, f.service);
    expect(await executor.execute(f.commandId, "cursor-fault-executor")).toMatchObject({ state: "completed" });
    expect(state(f)).toEqual({ state: "completed", failure_code: null });
    expect(state(previous.f)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
    expect(effects(previous.f)).toHaveLength(1);
    expect(f.database.authority.db.prepare("SELECT * FROM memory_outbox_control_cursor").get()).toBeUndefined();
    expect(reconcileMemoryOutboxCommands(f.database.authority, f.clock.now, 1))
      .toEqual({ commands_reconciled: 0, control_error: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
        failure: { phase: "control_reconciliation", error_code: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
          cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" } });
    f.database.authority.db.exec("DROP TRIGGER test_cursor_failure");
    expect(await f.service.runOnce("cursor-retry", 1)).toMatchObject({ commands_reconciled: 1, dispatched: 0 });
    expect(state(previous.f)).toEqual({ state: "completed", failure_code: null });
    expect(f.writer.calls).toHaveLength(1); expect(previous.f.writer.calls).toHaveLength(1);
  });
  it("removes a suppressed outbox cursor hint without removing unrelated scheduling metadata", async () => {
    const f = await fixture();
    f.database.authority.db.prepare(
      "INSERT INTO memory_outbox_control_cursor(singleton_id,last_updated_at,last_outbox_id) VALUES(1,?,?)",
    ).run(f.clock.now.toISOString(), "outbox:erased");
    removeSuppressedRows(f.database.authority.db, [{ kind: "outbox", id: "outbox:unrelated", component_id: "outbox:unrelated" }]);
    expect(f.database.authority.db.prepare("SELECT last_outbox_id FROM memory_outbox_control_cursor").get())
      .toEqual({ last_outbox_id: "outbox:erased" });
    removeSuppressedRows(f.database.authority.db, [{ kind: "outbox", id: "outbox:erased", component_id: "outbox:erased" }]);
    expect(f.database.authority.db.prepare("SELECT * FROM memory_outbox_control_cursor").get()).toBeUndefined();
  });
  it("advances past invalid evidence across restarts and later revisits the repaired command", async () => {
    const first = await settledLive();
    const second = await settledLive({ database: first.f.database, suffix: "-second" });
    for (const item of [first, second]) uncertain(item.f, item.claim.fence);
    const [bad, good] = [first, second].sort((a, b) => a.id < b.id ? -1 : 1) as [typeof first, typeof first];
    first.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?")
      .run(bad.f.commandId);
    const cycle = () => {
      const connection = new AuthorityDb(first.f.database.path);
      try { return reconcileMemoryOutboxCommands(connection, first.f.clock.now, 1); }
      finally { connection.close(); }
    };
    expect(cycle()).toEqual({ commands_reconciled: 0, control_error: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID",
      failure: { phase: "control_reconciliation", error_code: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
        cause_code: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" } });
    expect(cycle()).toEqual({ commands_reconciled: 1 });
    expect(state(good.f)).toEqual({ state: "completed", failure_code: null });
    expect(state(bad.f)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
    first.f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=? WHERE request_id=?")
      .run(bad.claim.fence, bad.f.commandId);
    expect(cycle()).toEqual({ commands_reconciled: 1 });
    expect(state(bad.f)).toEqual({ state: "completed", failure_code: null });
    expect(first.f.writer.calls).toHaveLength(1); expect(second.f.writer.calls).toHaveLength(1);
  });
  it("recovers after cleanup and restart, preserves the uncertain audit, and never redispatches", async () => {
    const { f, claim, id } = await settledLive(); uncertain(f, claim.fence);
    expect(new MemoryCandidateReviewSpool(join(f.database.root, "candidate-review")).paths()).toEqual([]);
    const restarted = new AuthorityDb(f.database.path);
    try {
      const later = new Date(f.clock.now.getTime() + 20 * 60_000);
      expect(reconcileMemoryOutboxCommands(restarted, later, 1)).toEqual({ commands_reconciled: 1 });
      expect(state(f)).toEqual({ state: "completed", failure_code: null });
      expect(effects(f).map(e => e.effect_type)).toContain("memory.outbox.reconciling");
      const completed = effects(f).find(e => e.effect_type === "memory.outbox.reconciled")!;
      expect(JSON.parse(completed.payload_json)).toMatchObject({ outbox_id: id, fence: claim.fence,
        receipt_id: claim.receipt_id, settlement_receipt_digest: f.service.get(id)?.settlement_receipt_digest });
      expect(completed.payload_json).not.toContain("ExampleAlpha");
      expect(reconcileMemoryOutboxCommands(restarted, later, 1)).toEqual({ commands_reconciled: 0 });
      expect(effects(f)).toHaveLength(2);
      await f.service.runOnce("restarted-worker", 1); expect(f.writer.calls).toHaveLength(1);
    } finally { restarted.close(); }
  });

  it("does not steal a live executor claim, but recovers a claimed command after its lease expires", async () => {
    const { f, id, control } = await settledLive();
    expect(control.reconcileMemoryOutbox(id, f.clock.now)).toBe(false);
    expect(state(f)).toEqual({ state: "claimed", failure_code: null });
    f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    expect(await f.service.runOnce("crash-recovery", 1)).toMatchObject({ commands_reconciled: 1, dispatched: 0, settled: 0 });
    expect(state(f)).toEqual({ state: "completed", failure_code: null });
    expect(f.writer.calls).toHaveLength(1);
  });

  it("accepts late artifact evidence after approval expiry without renewing authority", async () => {
    const f = await fixture({ writer: new FixtureWriter("uncertain") }); const claim = claimAction(f);
    const saga = f.service.enqueue(claim); await f.service.runOnce("uncertain-dispatch", 1); uncertain(f, claim.fence);
    f.clock.now = new Date(f.clock.now.getTime() + 20 * 60_000);
    const available = ready();
    vi.spyOn(f.reader, "readPage").mockImplementation(() => available.readPage());
    vi.spyOn(f.reader, "recentChanges").mockImplementation(() => available.recentChanges());
    expect(await f.service.runOnce("late-observation", 1)).toMatchObject({ settled: 1, commands_reconciled: 1, dispatched: 0 });
    expect(f.service.get(saga.outbox_id)?.state).toBe("settled");
    expect(state(f)).toEqual({ state: "completed", failure_code: null });
    expect(f.writer.calls).toHaveLength(1);
  });

  it("keeps cancellation visible even when the provider artifact is already settled", async () => {
    const { f, id, control } = await settledLive();
    control.cancel({ request_id: f.commandId, reason: "cancel after dispatch", actor: "principal:owner",
      revoked_at: f.clock.now.toISOString() }, f.clock.now);
    expect(control.reconcileMemoryOutbox(id, f.clock.now)).toBe(false);
    expect(await f.service.runOnce("cancel-check", 1)).toMatchObject({ commands_reconciled: 0, dispatched: 0 });
    expect(state(f)).toEqual({ state: "uncertain", failure_code: "CONTROL_CANCELLED_UNCERTAIN" });
    expect(f.service.get(id)?.state).toBe("settled"); expect(effects(f)).toEqual([]);
  });

  it.each(["request", "receipt", "digest"] as const)("preserves legacy %s revocation", async kind => {
    const { f, claim, id, control } = await settledLive(); uncertain(f, claim.fence);
    const ref = kind === "request" ? claim.request_id : kind === "receipt" ? claim.receipt_id : claim.command_digest;
    f.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
      .run(ref, "test revocation", f.clock.now.toISOString());
    expect(control.reconcileMemoryOutbox(id, f.clock.now)).toBe(false);
    expect(reconcileMemoryOutboxCommands(f.database.authority, f.clock.now, 1)).toEqual({ commands_reconciled: 0 });
    expect(state(f)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
  });

  it("atomically rolls back a failed control event commit and retries from durable proof", async () => {
    const { f, claim } = await settledLive(); uncertain(f, claim.fence);
    f.database.authority.db.exec(`CREATE TRIGGER test_control_commit_failure BEFORE INSERT ON control_events
      WHEN NEW.source='jarvis-memory-outbox' BEGIN SELECT RAISE(ABORT,'injected event failure'); END`);
    expect(await f.service.runOnce("event-fault", 1)).toMatchObject({ commands_reconciled: 0,
      control_error: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED", dispatched: 0 });
    expect(state(f)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
    expect(effects(f)).toHaveLength(1);
    f.database.authority.db.exec("DROP TRIGGER test_control_commit_failure");
    expect(await f.service.runOnce("event-retry", 1)).toMatchObject({ commands_reconciled: 1, dispatched: 0 });
    expect(state(f)).toEqual({ state: "completed", failure_code: null }); expect(effects(f)).toHaveLength(2);
  });

  it.each(["fence", "observation", "signature"] as const)("rejects damaged %s evidence without altering the settled outbox", async kind => {
    const { f, claim, id, control } = await settledLive(); uncertain(f, claim.fence);
    if (kind === "fence") f.database.authority.db.prepare(
      "UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?").run(f.commandId);
    else {
      // Fault injection only: production triggers prohibit changing these ledgers.
      const table = kind === "observation" ? "memory_reconciliation_events" : "control_command_receipts";
      const triggers = f.database.authority.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
        .all(table) as { name: string }[];
      for (const trigger of triggers) f.database.authority.db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      if (kind === "observation") f.database.authority.db.exec(
        "DELETE FROM memory_reconciliation_events WHERE event_type='artifact_observed'");
      else f.database.authority.db.exec("UPDATE control_command_receipts SET signature='invalid'");
    }
    expect(() => control.reconcileMemoryOutbox(id, f.clock.now)).toThrow("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID");
    expect(state(f)).toEqual({ state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" });
    expect(f.service.get(id)?.state).toBe("settled"); expect(effects(f)).toHaveLength(1);
  });

  it.each(["failed", "expired", "conflict"] as const)("projects terminal %s as failure", async mode => {
    const f = await fixture({ reader: new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
      evidence: [evidence(`sha256:${"f".repeat(64)}`)] }) });
    const claim = claimAction(f); const saga = f.service.enqueue(claim);
    if (mode === "conflict") await f.service.runOnce("conflict-dispatch", 1);
    uncertain(f, claim.fence);
    if (mode === "expired") f.clock.now = new Date(f.clock.now.getTime() + 86_400_000);
    expect(await f.service.runOnce("failure-observation", 1)).toMatchObject({ commands_reconciled: 1 });
    expect(f.service.get(saga.outbox_id)?.state).toBe(mode);
    expect(state(f)).toEqual({ state: "failed", failure_code: mode === "conflict" ? "ARTIFACT_DIGEST_MISMATCH"
      : mode === "expired" ? "MEMORY_OUTBOX_EXPIRED" : "MEMORY_OUTBOX_AUTHORITY_INVALID" });
    expect(f.writer.calls).toHaveLength(mode === "conflict" ? 1 : 0);
  });

  it("returns the recovered completion when the executor dispatch outlives its claim", async () => {
    const f = await fixture({ reader: ready() }); const original = f.writer.write.bind(f.writer);
    vi.spyOn(f.writer, "write").mockImplementation(request => {
      f.clock.now = new Date(f.clock.now.getTime() + 60_000); return original(request);
    });
    const executor = new ApprovedCommandExecutor(f.database.authority, undefined, undefined, {}, () => f.clock.now, f.service);
    expect(await executor.execute(f.commandId, "slow-executor")).toMatchObject({ state: "completed" });
    expect(state(f)).toEqual({ state: "completed", failure_code: null });
    expect(effects(f)).toHaveLength(1); expect(f.writer.calls).toHaveLength(1);
  });

  it("reports immediate conflict as failed from the original executor", async () => {
    const f = await fixture({ reader: new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
      evidence: [evidence(`sha256:${"f".repeat(64)}`)] }) });
    const executor = new ApprovedCommandExecutor(f.database.authority, undefined, undefined, {}, () => f.clock.now, f.service);
    expect(await executor.execute(f.commandId, "conflict-executor")).toMatchObject({ state: "failed", failure_code: "ARTIFACT_DIGEST_MISMATCH" });
    expect(state(f)).toEqual({ state: "failed", failure_code: "ARTIFACT_DIGEST_MISMATCH" });
  });
});
