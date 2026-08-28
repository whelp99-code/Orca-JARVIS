import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, insertApproval, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

function insertCandidate(db: AuthorityDb, id: string): void {
  db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `corr:${id}`, `idem:${id}`, "verified_fact", "remember", digest("a"), digest("b"), digest("c"), "normal", "continuity", 0, "proposed", T5, T0, T0);
  db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?").run(T1, id);
  db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id=?").run(T1, id);
}

describe("memory outbox persistence", () => {
  it("allows one outbox row per candidate and semantic idempotency key", async () => {
    // Given one approved candidate
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:one");
      // When one semantic outbox row is queued
      db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:one", "memcand:one", "idem:send:one", "remember", digest("d"), digest("e"), "queued", 0, T5, T0, T0);
      // Then candidate and key duplication fail
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:two", "memcand:one", "idem:send:two", "remember", digest("d"), digest("e"), "queued", 0, T5, T0, T0)).toThrow(/UNIQUE constraint failed/);
      insertCandidate(db, "memcand:two");
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:three", "memcand:two", "idem:send:one", "remember", digest("f"), digest("1"), "queued", 0, T5, T0, T0)).toThrow(/UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("requires accepted provider response and current-fence reconciliation", async () => {
    // Given one current delivering outbox
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:delivery");
      db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:delivery", "memcand:delivery", "idem:send:delivery", "remember", digest("2"), digest("3"), "queued", 0, T5, T0, T0);
      db.db.prepare("UPDATE memory_outbox SET state='delivering',lease_owner='memory:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE outbox_id='memout:delivery'").run(T3, T1);
      db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:one", "memout:delivery", 1, digest("4"), "accepted", T1);
      // When provider acceptance and observed artifact are recorded
      db.db.prepare("UPDATE memory_outbox SET state='accepted_unsettled',updated_at=? WHERE outbox_id='memout:delivery'").run(T2);
      db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?,?)").run("memrec:one", "memout:delivery", "mema:one", 1, "artifact_observed", digest("3"), digest("5"), T2);
      // Then duplicate sends/effects and stale fence fail
      expect(() => db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:two", "memout:delivery", 1, digest("4"), "accepted", T2)).toThrow(/UNIQUE constraint failed|memory outbox current fence required/);
      expect(() => db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?,?)").run("memrec:two", "memout:delivery", "mema:one", 1, "artifact_observed", digest("3"), digest("5"), T2)).toThrow(/UNIQUE constraint failed/);
      expect(db.db.prepare("UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,settled_at=?,updated_at=? WHERE outbox_id='memout:delivery' AND lease_fence=0").run(T2, T2).changes).toBe(0);
      db.db.prepare("UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,settled_at=?,updated_at=? WHERE outbox_id='memout:delivery' AND lease_fence=1").run(T2, T2);
      expect(() => db.db.prepare("DELETE FROM memory_outbox_attempts WHERE attempt_id='mema:one'").run()).toThrow("immutable memory outbox attempt");
    } finally { closePersonalDb(db); }
  });

  it("requires exact deletion authority and preserves dominant tombstones", async () => {
    // Given an exact requested deletion and local owner receipt
    const db = await personalDb();
    try {
      const identity = { deletion_id: "del:one", subject_digest: digest("6"), scope_digest: digest("7"), target_digest: digest("8") };
      const approval = insertApproval(db, { suffix: "delete", action: "memory.delete", target: identity, args: { operation: "forget", args_digest: digest("9") } });
      db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(identity.deletion_id, "corr:delete", "idem:delete", "forget", identity.subject_digest, identity.scope_digest, identity.target_digest, digest("9"), "local-owner", "requested", 0, T5, T0, T0);
      // When state tries to skip approval
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, identity.deletion_id)).toThrow("memory deletion transition invalid");
      // Then exact lifecycle writes one immutable tombstone before settlement
      db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,updated_at=? WHERE deletion_id=?").run(approval.requestId, approval.receiptId, approval.receiptDigest, T1, identity.deletion_id);
      db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, identity.deletion_id);
      db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='delete:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id=?").run(T3, T1, identity.deletion_id);
      db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effect_lease_owner,effect_lease_fence,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:one", identity.deletion_id, identity.subject_digest, identity.scope_digest, identity.target_digest, digest("9"), approval.requestId, approval.receiptId, approval.receiptDigest, "delete:one", 1, T2, digest("0"), T2);
      db.db.prepare("UPDATE memory_deletion_requests SET state='tombstoned',updated_at=? WHERE deletion_id=?").run(T2, identity.deletion_id);
      db.db.prepare("UPDATE memory_deletion_requests SET state='settled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE deletion_id=?").run(T2, identity.deletion_id);
      expect(() => db.db.prepare("UPDATE memory_tombstones SET effective_at=? WHERE tombstone_id='tmb:one'").run(T4)).toThrow("immutable memory tombstone");
      expect(() => db.db.prepare("DELETE FROM memory_tombstones WHERE tombstone_id='tmb:one'").run()).toThrow("immutable memory tombstone");
    } finally { closePersonalDb(db); }
  });
});
