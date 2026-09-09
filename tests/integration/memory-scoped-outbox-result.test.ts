import { expect, it } from "vitest";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";
import { recordMemoryScopedOutboxAcceptance } from "../../src/memory-scoped-outbox-result.js";
import { parseSecondBrainScopedWriteAccepted } from "../../src/second-brain-scoped-write-result.js";
import { memoryHash } from "../../src/memory-candidate-values.js";

async function setup() {
  const f = await scopedOutboxFixture();
  const r = registerMemoryScopedOutbox(f.options, f.claimed), options = { ...f.options, roots: f.dispatch.roots };
  const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:fixture", 1000)!;
  const dispatch = markMemoryScopedOutboxDispatch(options, lease, 30000), request = dispatch.request;
  const accepted_at = f.now.toISOString();
  const accepted = { schema_version: 4, kind: "accepted", state: "pending", provider_instance_id: request.provider_instance_id,
    request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
    scope_digest: request.preparation.binding.identity_digest, accepted_at, inbox_path: `pending/${request.request_id}.v4.json`,
    request_file_digest: memoryHash("second-brain/inbox-write-request/v4\0", { schema_version: 4, state: "pending", accepted_at, request }), replayed: false };
  return { ...f, dispatch, accepted };
}
it("records a delayed acceptance atomically and normalizes transport replay without settling", async () => {
  const f = await setup();
  try {
    const db = f.database.authority.db, d = f.dispatch;
    const late = new Date(f.now.getTime() + 60000);
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, late)).toBe(1);
    expect(db.prepare("SELECT failure_code FROM memory_outbox").get()).toEqual({ failure_code: "DISPATCH_OUTCOME_UNKNOWN" });
    const first = recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence, d.request, f.accepted, late);
    expect(first.replayed).toBe(false);
    expect(db.prepare("SELECT state,failure_code FROM memory_outbox").get()).toEqual({ state: "reconciling", failure_code: null });
    const beforeReplay = db.prepare("SELECT total_changes() AS n").get();
    expect(recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence, d.request,
      { ...f.accepted, replayed: true }, late)).toEqual({ ...first, replayed: true });
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(beforeReplay);
    const changedAt = new Date(f.now.getTime() + 1).toISOString();
    const changed = { ...f.accepted, accepted_at: changedAt, request_file_digest: memoryHash("second-brain/inbox-write-request/v4\0",
      { schema_version: 4, state: "pending", accepted_at: changedAt, request: d.request }) };
    expect(parseSecondBrainScopedWriteAccepted(changed, d.request, late)).toEqual(changed);
    expect(() => recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence, d.request, changed, late))
      .toThrow("SCOPED_OUTBOX_ACCEPTANCE_CONFLICT");
    expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
    expect(db.prepare("SELECT outcome FROM memory_outbox_attempts").get()).toEqual({ outcome: "accepted" });
    expect(db.prepare("SELECT state FROM memory_candidates").get()).toEqual({ state: "accepted_unsettled" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it("rejects mismatched provider, scope, request, envelope hash, time, shape and attempt", async () => {
  const f = await setup();
  try {
    const d = f.dispatch;
    const changes = [{ provider_instance_id: "provider:other" }, { scope_digest: "sha256:" + "a".repeat(64) },
      { request_id: "other" }, { request_digest: "sha256:" + "a".repeat(64) }, { idempotency_key: "other" },
      { inbox_path: "../other" }, { request_file_digest: "sha256:" + "a".repeat(64) }, { state: "proved" },
      { schema_version: 3 }, { accepted_at: new Date(f.now.getTime() + 1).toISOString() }, { extra: true }, { replayed: 1 }];
    for (const change of changes) expect(() => recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id,
      d.fence, d.request, { ...f.accepted, ...change }, f.now)).toThrow();
    expect(() => recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence + 1, d.request, f.accepted, f.now)).toThrow();
    expect(f.database.authority.db.prepare("SELECT outcome FROM memory_outbox_attempts").get()).toEqual({ outcome: "dispatching" });
    expect(parseSecondBrainScopedWriteAccepted(f.accepted, d.request, f.now)).toEqual(f.accepted);
  } finally { closeMemoryDatabase(f.database); }
});
it("rolls back the accepted attempt when the outbox transition fails", async () => {
  const f = await setup();
  try {
    const db = f.database.authority.db, d = f.dispatch;
    db.exec("CREATE TEMP TRIGGER injected_result_failure BEFORE UPDATE OF state ON memory_outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence, d.request, f.accepted, f.now)).toThrow("injected");
    expect(db.prepare("SELECT outcome FROM memory_outbox_attempts").get()).toEqual({ outcome: "dispatching" });
    expect(db.prepare("SELECT count(*) AS n FROM memory_reconciliation_events WHERE event_type='provider_accepted'").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER injected_result_failure");
    expect(recordMemoryScopedOutboxAcceptance(f.database.authority, d.outbox_id, d.fence, d.request, f.accepted, f.now).replayed).toBe(false);
    expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
  } finally { closeMemoryDatabase(f.database); }
});
