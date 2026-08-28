import { describe, expect, it } from "vitest";
import { closePersonalDb, digest, insertApproval, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

function insertCandidate(db: Awaited<ReturnType<typeof personalDb>>, id: string): void {
  db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `corr:${id}`, `idem:${id}`, "verified_fact", "remember", digest("a"), digest("b"), digest("c"), "normal", "continuity", 0, "proposed", null, T5, T0, T0);
  db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?").run(T1, id);
  db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id=?").run(T1, id);
}

describe("memory outbox persistence", () => {
  it("allows one outbox row per candidate and semantic idempotency key", async () => {
    // Given one approved memory candidate
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:one");
      // When its outbox row is queued
      db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:one", "memcand:one", "idem:memory-send:one", "remember", digest("d"), digest("e"), "queued", 0, T5, T0, T0);
      // Then duplicate candidate and semantic key sends fail
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:two", "memcand:one", "idem:memory-send:two", "remember", digest("d"), digest("e"), "queued", 0, T5, T0, T0)).toThrow(/UNIQUE constraint failed/);
      insertCandidate(db, "memcand:two");
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:three", "memcand:two", "idem:memory-send:one", "remember", digest("f"), digest("1"), "queued", 0, T5, T0, T0)).toThrow(/UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("fences delivery and rejects duplicate attempts and observed effects", async () => {
    // Given a queued candidate outbox
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:delivery");
      db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:delivery", "memcand:delivery", "idem:memory-send:delivery", "remember", digest("2"), digest("3"), "queued", 0, T5, T0, T0);
      db.db.prepare("UPDATE memory_outbox SET state='delivering',lease_owner='memory:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE outbox_id='memout:delivery'").run(T3, T1);
      // When one append-only send attempt and reconciliation effect are recorded
      db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:one", "memout:delivery", 1, digest("4"), "accepted", T1);
      db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?)").run("memrec:one", "memout:delivery", "mema:one", "artifact_observed", digest("3"), digest("5"), T2);
      // Then stale settlement, duplicate send, and duplicate effect fail
      expect(() => db.db.prepare("UPDATE memory_outbox SET state='settled',lease_fence=0,updated_at=? WHERE outbox_id='memout:delivery'").run(T2)).toThrow("memory outbox stale fence");
      expect(() => db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:two", "memout:delivery", 1, digest("4"), "accepted", T2)).toThrow(/UNIQUE constraint failed/);
      expect(() => db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?)").run("memrec:two", "memout:delivery", "mema:one", "artifact_observed", digest("3"), digest("5"), T2)).toThrow(/UNIQUE constraint failed/);
      db.db.prepare("UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,settled_at=?,updated_at=? WHERE outbox_id='memout:delivery'").run(T2, T2);
      expect(() => db.db.prepare("DELETE FROM memory_outbox_attempts WHERE attempt_id='mema:one'").run()).toThrow("immutable memory outbox attempt");
    } finally { closePersonalDb(db); }
  });

  it("requires confirmation before deletion and preserves dominant tombstones", async () => {
    // Given an exact approved deletion receipt and a requested deletion
    const db = await personalDb();
    try {
      const approval = insertApproval(db, "delete", "memory.delete", "owner");
      db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,subject_digest,scope_digest,state,confirmation_request_id,confirmation_receipt_id,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("del:one", "corr:delete", "idem:delete:one", digest("6"), digest("7"), "requested", null, null, 0, T5, T0, T0);
      // When deletion tries to skip exact confirmation
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id='del:one'").run(T1)).toThrow("memory deletion transition invalid");
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='approved',updated_at=? WHERE deletion_id='del:one'").run(T1)).toThrow("memory deletion approval required");
      // Then the approved lifecycle can create one immutable dominant tombstone
      db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,updated_at=? WHERE deletion_id='del:one'").run(approval.requestId, approval.receiptId, T1);
      db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id='del:one'").run(T1);
      db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='delete:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id='del:one'").run(T3, T1);
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET lease_fence=0,updated_at=? WHERE deletion_id='del:one'").run(T2)).toThrow("memory deletion stale fence");
      db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,approval_receipt_id,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?)").run("tmb:one", "del:one", digest("6"), digest("7"), approval.receiptId, T2, digest("8"), T2);
      for (const state of ["tombstoned", "purging", "verifying", "settled"] as const) db.db.prepare("UPDATE memory_deletion_requests SET state=?,updated_at=? WHERE deletion_id='del:one'").run(state, T2);
      expect(() => db.db.prepare("UPDATE memory_tombstones SET effective_at=? WHERE tombstone_id='tmb:one'").run(T4)).toThrow("immutable memory tombstone");
      expect(() => db.db.prepare("DELETE FROM memory_tombstones WHERE tombstone_id='tmb:one'").run()).toThrow("immutable memory tombstone");
      expect(db.db.prepare("SELECT state FROM memory_deletion_requests WHERE deletion_id='del:one'").get()).toEqual({ state: "settled" });
    } finally { closePersonalDb(db); }
  });
});
