import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { canonicalize } from "../../src/canonical.js";
import { MemoryCorrectionCancellationIssuer } from "../../src/memory-correction-cancellation-issuer.js";
import { MemoryCorrectionStore } from "../../src/memory-correction-store.js";
import { MemoryDestructiveDispatchCursor } from "../../src/memory-destructive-dispatch.js";
import { registerMemoryEffectDelegationKey, revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { requireCorrectionCancellationIntent } from "../../src/memory-correction-cancellation-intent.js";
import { cancellationDatabaseFixture } from "../fixtures/memory-cancellation-db.js";
import { correctionPreparedFixture } from "../fixtures/memory-correction-control.js";

it("derives evidence from real suppression and commits a body-free intent with replay after reopen", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    const before = readFileSync(f.spoolPath);
    const issuer = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock);
    const intent = issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
    expect(intent.unsent_evidence).toMatchObject({ candidate_id: f.candidate.candidate_id,
      dispatch_fence: 0, attempt_count: 0, active_cursor: false });
    const event = f.db.db.prepare("SELECT event_digest FROM memory_suppression_events WHERE sequence=1").get() as any;
    expect(intent.unsent_evidence.suppression_event_digest).toBe(event.event_digest);
    expect(requireCorrectionCancellationIntent(intent, { now: f.runtime.clock(), provider_instance_id: "provider:fixture",
      historical_delegation_keys: new Map([[f.runtime.signing_key_id, createPublicKey(f.runtime.private_key)]]),
      current_cancellation_keys: new Map([[f.runtime.signing_key_id, createPublicKey(f.runtime.private_key)]]) })).toEqual(intent);
    const reopened = new AuthorityDb(f.database.path);
    try {
      expect(new MemoryCorrectionCancellationIssuer(reopened, f.runtime.clock)
        .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toEqual(intent);
    } finally { reopened.close(); }
    const source = f.db.db.prepare("SELECT source_json FROM memory_correction_cancellation_sources").get() as any;
    expect(source.source_json).not.toContain(f.staged.content);
    expect(canonicalize(intent)).not.toContain(f.staged.content);
    expect(readFileSync(f.spoolPath)).toEqual(before);
    expect(f.db.db.prepare("SELECT active_lane_id,fence,accepted_through_sequence FROM memory_effect_dispatch_cursor").get())
      .toEqual({ active_lane_id: null, fence: 0, accepted_through_sequence: 0 });
    expect(() => f.db.db.prepare("DELETE FROM memory_correction_cancellation_intents").run()).toThrow("immutable");
    expect(() => f.db.db.prepare("UPDATE memory_correction_cancellation_sources SET source_json='{}'").run()).toThrow("immutable");
  } finally { await f.close(); }
});

it.each(["quarantine", "unsuppressed"] as const)("does not invent suppression event evidence for %s", async mode => {
  const f = await cancellationDatabaseFixture(mode);
  try {
    expect(() => new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock)
      .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toThrow("MEMORY_CANCELLATION_SUPPRESSION_UNPROVED");
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_intents").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it.each(["cursor", "accepted", "attempt"] as const)("rejects actual %s evidence before issuing", async state => {
  const f = await cancellationDatabaseFixture();
  try {
    if (state === "cursor") new MemoryDestructiveDispatchCursor(f.db).claim({ lane: "correction", lane_id: f.record.lane_id,
      sequence: f.record.tombstone_sequence, request_digest: f.record.request_digest }, f.runtime.clock());
    if (state === "accepted") f.db.db.prepare("UPDATE memory_effect_dispatch_cursor SET accepted_through_sequence=1").run();
    if (state === "attempt") f.db.db.prepare(`INSERT INTO memory_correction_attempts
      (attempt_id,correction_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at)
      VALUES('test',?,1,?,'dispatching',?,?)`).run(f.record.correction_id, `sha256:${"a".repeat(64)}`, f.runtime.clock().toISOString(), f.runtime.clock().toISOString());
    expect(() => new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock)
      .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toThrow("MEMORY_CANCELLATION_UNSENT_UNPROVED");
  } finally { await f.close(); }
});

it("prevents later cursor claims, direct dispatch transitions and attempts after issuance", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock).issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
    expect(() => new MemoryDestructiveDispatchCursor(f.db).claim({ lane: "correction", lane_id: f.record.lane_id,
      sequence: 1, request_digest: f.record.request_digest }, f.runtime.clock())).toThrow("MEMORY_REQUEST_CANCELLED");
    try { new MemoryCorrectionStore(f.db).beginDispatch(f.record.correction_id, f.runtime.clock()); throw new Error("unexpected dispatch"); }
    catch (error) { expect(error).toMatchObject({ code: "MEMORY_REQUEST_CANCELLED" }); }
    expect(() => f.db.db.prepare("UPDATE memory_correction_requests SET state='dispatching',dispatch_fence=1").run()).toThrow("MEMORY_REQUEST_CANCELLED");
    expect(() => f.db.db.prepare(`INSERT INTO memory_correction_attempts
      (attempt_id,correction_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at)
      VALUES('test',?,1,?,'dispatching',?,?)`).run(f.record.correction_id, `sha256:${"a".repeat(64)}`, f.runtime.clock().toISOString(), f.runtime.clock().toISOString()))
      .toThrow("MEMORY_REQUEST_CANCELLED");
  } finally { await f.close(); }
});

it("uses revoked historical keys only to verify history and a distinct active key to issue", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    revokeMemoryEffectDelegationKey(f.db, f.runtime.signing_key_id);
    const issuer = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock);
    expect(() => issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toThrow("MEMORY_CANCELLATION_KEY_UNAVAILABLE");
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 71)]), type: "pkcs8", format: "der" });
    registerMemoryEffectDelegationKey(f.db, { key_id: "new", principal_id: "principal:owner",
      public_key_pem: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
      valid_from: f.runtime.clock().toISOString(), valid_until: "2026-08-29T00:00:00.000Z" }, f.runtime.clock());
    const intent = issuer.issue(f.record.correction_id, "new", key);
    expect(intent.signing_key_id).toBe("new");
    expect(intent.original_delegation.signing_key_id).toBe(f.runtime.signing_key_id);
  } finally { await f.close(); }
});

it("rechecks the current clock before persistence and rolls back expired issuance", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    let calls = 0;
    const issuer = new MemoryCorrectionCancellationIssuer(f.db, () => new Date(f.runtime.clock().getTime() + (calls++ ? 300_000 : 0)));
    expect(() => issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toThrow();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_intents").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

it("rolls materialization back if cancellation source cannot be preserved", async () => {
  const f = await correctionPreparedFixture();
  try {
    f.db.db.exec("CREATE TRIGGER fail_cancellation_source BEFORE INSERT ON memory_correction_cancellation_sources BEGIN SELECT RAISE(ABORT,'source-write-failed'); END;");
    await expect(f.saga.dispatch(f.claim)).rejects.toThrow("source-write-failed");
    for (const table of ["memory_correction_requests", "memory_correction_cancellation_sources", "memory_tombstone_chain"]) {
      expect(f.db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(f.db.db.prepare("SELECT state FROM memory_effect_preparations").get()).toEqual({ state: "staged" });
    expect(f.writer.calls).toHaveLength(0);
  } finally { await f.close(); }
});

it("revalidates current time on stored replay without renewing the intent", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    const initial = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock)
      .issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
    let calls = 0;
    const issuer = new MemoryCorrectionCancellationIssuer(f.db, () => new Date(f.runtime.clock().getTime() + (calls++ ? 300_000 : 0)));
    expect(() => issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key)).toThrow();
    expect(f.db.db.prepare("SELECT intent_json FROM memory_correction_cancellation_intents").get())
      .toEqual({ intent_json: canonicalize(initial) });
  } finally { await f.close(); }
});

it("rejects a corrupted stored intent identity rather than replaying it", async () => {
  const f = await cancellationDatabaseFixture();
  try {
    const issuer = new MemoryCorrectionCancellationIssuer(f.db, f.runtime.clock);
    issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key);
    f.db.db.exec("DROP TRIGGER memory_cancellation_intent_no_update");
    f.db.db.prepare("UPDATE memory_correction_cancellation_intents SET intent_digest=?").run(`sha256:${"0".repeat(64)}`);
    expect(() => issuer.issue(f.record.correction_id, f.runtime.signing_key_id, f.runtime.private_key))
      .toThrow("MEMORY_CANCELLATION_DB_BINDING_INVALID");
  } finally { await f.close(); }
});
