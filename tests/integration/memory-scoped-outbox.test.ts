import { ControlPlane } from "../../src/control-plane.js";
import { expect, it } from "vitest";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { readApprovedMemoryScopeReview } from "../../src/memory-scope-review.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";

it("atomically consumes a scope review with one scoped outbox registration and replays its acknowledgement", async () => {
  const f = await scopedOutboxFixture();
  try {
    const db = f.database.authority.db;
    const registered = registerMemoryScopedOutbox(f.options, f.claimed);
    expect(registered).toMatchObject({ kind: "registered", state: "queued", replayed: false });
    expect(db.prepare("SELECT request_profile,state FROM memory_outbox").get()).toEqual({ request_profile: "scoped-v4", state: "queued" });
    expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_outbox_bindings").get()).toEqual({ n: 1 });
    expect(() => readApprovedMemoryScopeReview(f.database.authority, f.options.proposal, f.review.request_id, f.now)).toThrow();
    expect(registerMemoryScopedOutbox(f.options, f.claimed)).toEqual({ ...registered, replayed: true });
    expect(() => registerMemoryScopedOutbox({ ...f.options, providerInstanceId: "provider:other" }, f.claimed)).toThrow("SCOPED_OUTBOX_REPLAY_CONFLICT");
    const legacy = new MemoryOutboxStore(f.database.authority, 30000);
    expect(legacy.claimDispatch("legacy", f.now, 1000)).toBeUndefined();
    expect(legacy.list(undefined, 10)).toEqual([]);
    expect(() => legacy.get(registered.outbox_id)).toThrow("MEMORY_OUTBOX_PROFILE_UNSUPPORTED");
    new ControlPlane(f.database.authority).recoverExpired(new Date(f.now.getTime() + 61000));
    expect(registerMemoryScopedOutbox(f.options, f.claimed)).toEqual({ ...registered, replayed: true });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it("rolls back scope consumption when outbox insertion fails and reuses published bytes on retry", async () => {
  const f = await scopedOutboxFixture();
  try {
    const db = f.database.authority.db;
    db.exec("CREATE TEMP TRIGGER inject_scoped_failure BEFORE INSERT ON memory_outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END");
    expect(() => registerMemoryScopedOutbox(f.options, f.claimed)).toThrow("injected outbox failure");
    expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_outbox_bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM memory_outbox").get()).toEqual({ n: 0 });
    expect(readApprovedMemoryScopeReview(f.database.authority, f.options.proposal, f.review.request_id, f.now).writes_authorized).toBe(false);
    db.exec("DROP TRIGGER inject_scoped_failure");
    expect(registerMemoryScopedOutbox(f.options, f.claimed).replayed).toBe(false);
  } finally { closeMemoryDatabase(f.database); }
});
it("rejects modified dispatch command arguments without consuming the scope review", async () => {
  const f = await scopedOutboxFixture();
  try {
    const changed = { ...f.claimed, args: { ...f.claimed.args, expected_artifact: {
      ...(f.claimed.args.expected_artifact as object), page_id: "wiki/other" } } };
    expect(() => registerMemoryScopedOutbox(f.options, changed)).toThrow("SCOPED_OUTBOX_CLAIM_INVALID");
    expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_scoped_outbox_bindings").get()).toEqual({ n: 0 });
  } finally { closeMemoryDatabase(f.database); }
});

it("cannot commit review consumption without its outbox row", async () => {
  const f = await scopedOutboxFixture();
  try {
    const db = f.database.authority.db;
    const receipt = readApprovedMemoryScopeReview(f.database.authority, f.options.proposal, f.review.request_id, f.now);
    expect(() => db.transaction(() => {
      db.prepare(`INSERT INTO memory_scoped_outbox_bindings(outbox_id,candidate_id,request_id,request_digest,idempotency_key,
        provider_instance_id,scope_digest,scope_review_request_id,scope_review_receipt_id,scope_command_digest,
        source_request_id,source_request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("missing-outbox",
        f.candidate.candidate_id, "request:fixture", "sha256:" + "a".repeat(64), "key:fixture", "provider:fixture",
        "sha256:" + "b".repeat(64), f.review.request_id, receipt.control_receipt_id, receipt.command_digest,
        f.request.request_id, f.request.request_digest, f.now.toISOString());
    }).immediate()).toThrow("FOREIGN KEY constraint failed");
    expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_outbox_bindings").get()).toEqual({ n: 0 });
  } finally { closeMemoryDatabase(f.database); }
});
