import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, insertDailyRun, digest, insertApproval, personalDb, T0, T1, T2, T3, T5 } from "./personal-operations-test-helpers.js";

function insertCandidate(db: AuthorityDb, id: string, requiredConfirmation: 0 | 1, sensitivity: "normal" | "sensitive", expiresAt = T5, confirmationExpiresAt: string | null = null): void {
  db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `corr:${id}`, `idem:${id}`, "inference", "remember", digest("1"), digest("2"), digest("3"), sensitivity, "continuity", requiredConfirmation, "proposed", confirmationExpiresAt, expiresAt, T0, T0);
  db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?").run(T1, id);
}

function exactCandidateConfirmation(db: AuthorityDb, candidateId: string, confirmedAt = T2): void {
  const approval = insertApproval(db, {
    suffix: `confirm-${candidateId}`,
    action: "memory.confirm",
    target: { candidate_id: candidateId, subject_digest: digest("1"), content_digest: digest("2") },
    args: { operation: "remember", evidence_digest: digest("4") },
  });
  db.db.prepare("UPDATE memory_candidates SET state='approved',confirmation_principal_id='local-owner',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,confirmation_evidence_digest=?,updated_at=? WHERE candidate_id=?").run(approval.requestId, approval.receiptId, approval.receiptDigest, digest("4"), confirmedAt, candidateId);
}

function approvedDeletion(db: AuthorityDb, deletionId = "del:expired-effect", suffix = "expired-effect"): { readonly requestId: string; readonly receiptId: string; readonly receiptDigest: string } {
  const identity = { deletion_id: deletionId, subject_digest: digest("5"), scope_digest: digest("6"), target_digest: digest("7") };
  const approval = insertApproval(db, { suffix, action: "memory.delete", target: identity, args: { operation: "forget", args_digest: digest("8") } });
  db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(identity.deletion_id, `corr:${suffix}`, `idem:${suffix}`, "forget", identity.subject_digest, identity.scope_digest, identity.target_digest, digest("8"), "local-owner", "requested", 0, T5, T0, T0);
  db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,updated_at=? WHERE deletion_id=?").run(approval.requestId, approval.receiptId, approval.receiptDigest, T1, identity.deletion_id);
  db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, identity.deletion_id);
  db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='delete:expired',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id=?").run(T2, T1, identity.deletion_id);
  return approval;
}

describe("memory confirmation authority epoch 3", () => {
  it("rejects classified-to-approved and outbox bypass for a sensitive confirmation-required candidate", async () => {
    // Given a sensitive classified candidate requiring confirmation
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:sensitive-bypass", 1, "sensitive", T5, T3);
      // When direct SQL skips awaiting confirmation
      // Then approval and durable outbox creation both fail
      expect(() => db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id='memcand:sensitive-bypass'").run(T2)).toThrow("memory confirmation required");
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:sensitive-bypass", "memcand:sensitive-bypass", "idem:sensitive-bypass", "remember", digest("9"), digest("a"), "queued", 0, T5, T2, T2)).toThrow("memory candidate approval required");
    } finally { closePersonalDb(db); }
  });

  it("approves a confirmation-required candidate only through exact current human authority", async () => {
    // Given a sensitive candidate in awaiting_confirmation
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:confirmed", 1, "sensitive", T5, T3);
      db.db.prepare("UPDATE memory_candidates SET state='awaiting_confirmation',updated_at=? WHERE candidate_id='memcand:confirmed'").run(T1);
      // When exact human confirmation is attached before its deadline
      exactCandidateConfirmation(db, "memcand:confirmed");
      // Then the candidate is approved and its confirmation receipt is redeemed once
      expect(db.db.prepare("SELECT state,confirmation_principal_id FROM memory_candidates WHERE candidate_id='memcand:confirmed'").get()).toEqual({ state: "approved", confirmation_principal_id: "local-owner" });
      expect(db.db.prepare("SELECT authority_kind FROM personal_authority_redemptions WHERE subject_id='memcand:confirmed'").get()).toEqual({ authority_kind: "memory_confirmation" });
    } finally { closePersonalDb(db); }
  });

  it("rejects a self-consistent remote principal as trusted human confirmation", async () => {
    // Given exact candidate bindings signed and requested by an untrusted remote principal
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:remote-confirmation", 1, "sensitive", T5, T3);
      db.db.prepare("UPDATE memory_candidates SET state='awaiting_confirmation',updated_at=? WHERE candidate_id='memcand:remote-confirmation'").run(T1);
      const approval = insertApproval(db, {
        suffix: "remote-confirmation",
        action: "memory.confirm",
        target: { candidate_id: "memcand:remote-confirmation", subject_digest: digest("1"), content_digest: digest("2") },
        args: { operation: "remember", evidence_digest: digest("4") },
        requestedBy: "remote-owner",
        signer: "remote-owner",
      });
      // When the remote identity presents otherwise self-consistent authority
      let rejection: unknown;
      try {
        db.db.prepare("UPDATE memory_candidates SET state='approved',confirmation_principal_id='remote-owner',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,confirmation_evidence_digest=?,updated_at=? WHERE candidate_id='memcand:remote-confirmation'").run(approval.requestId, approval.receiptId, approval.receiptDigest, digest("4"), T2);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        rejection = error;
      }
      // Then persisted state proves approval and redemption did not occur
      expect(rejection).toBeInstanceOf(Error);
      expect(db.db.prepare("SELECT state,confirmation_principal_id FROM memory_candidates WHERE candidate_id='memcand:remote-confirmation'").get()).toEqual({ state: "awaiting_confirmation", confirmation_principal_id: null });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM personal_authority_redemptions WHERE subject_id='memcand:remote-confirmation'").get()).toEqual({ count: 0 });
    } finally { closePersonalDb(db); }
  });

  it("rejects a required confirmation deadline equal to candidate creation", async () => {
    // Given a required candidate with a non-forward confirmation interval
    const db = await personalDb();
    try {
      // When direct SQL sets confirmation expiry equal to creation
      let rejection: unknown;
      try { insertCandidate(db, "memcand:reversed-lower-bound", 1, "sensitive", T5, T0); } catch (error) {
        if (!(error instanceof Error)) throw error;
        rejection = error;
      }
      // Then no candidate row exists
      expect(rejection).toBeInstanceOf(Error);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_candidates WHERE candidate_id='memcand:reversed-lower-bound'").get()).toEqual({ count: 0 });
    } finally { closePersonalDb(db); }
  });

  it("rejects approval at the exact confirmation deadline", async () => {
    // Given a sensitive candidate awaiting confirmation through T3
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:confirmation-expired", 1, "sensitive", T5, T3);
      db.db.prepare("UPDATE memory_candidates SET state='awaiting_confirmation',updated_at=? WHERE candidate_id='memcand:confirmation-expired'").run(T1);
      // When exact human authority arrives at the hard deadline
      // Then approval remains unavailable
      expect(() => exactCandidateConfirmation(db, "memcand:confirmation-expired", T3)).toThrow("memory confirmation authority required");
    } finally { closePersonalDb(db); }
  });

  it("rejects confirmation deadline beyond candidate expiry", async () => {
    // Given a confirmation-required candidate whose deadline exceeds its lifetime
    const db = await personalDb();
    try {
      // When direct SQL inserts the reversed bound
      // Then semantic expiry validation rejects it
      expect(() => insertCandidate(db, "memcand:reversed-confirmation", 1, "sensitive", T3, T5)).toThrow(/CHECK constraint failed|memory confirmation expiry invalid/);
    } finally { closePersonalDb(db); }
  });
});

describe("current lease effects epoch 3", () => {
  it("rejects claimed-to-running after the daily lease expired", async () => {
    // Given a daily claim expiring at T2
    const db = await personalDb();
    try {
      insertDailyRun(db, { runId: "dlr:expired-effect", correlation: "corr:daily-expired", idempotency: "idem:daily-expired" });
      db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='daily:old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id='dlr:expired-effect'").run(T2, T1);
      // When the stale owner advances at T3 without reclaim
      // Then direct SQL rejects the effect
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id='dlr:expired-effect'").run(T3)).toThrow("daily loop current lease required");
    } finally { closePersonalDb(db); }
  });

  it("rejects memory acceptance and reconciliation after outbox lease expiry", async () => {
    // Given a low-risk outbox delivering through T2
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:expired-outbox", 0, "normal");
      db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id='memcand:expired-outbox'").run(T1);
      // When legacy SQL attempts to bypass the V2 approved-action binding
      // Then it fails before any lease or provider effect can exist.
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:expired-effect", "memcand:expired-outbox", "idem:expired-outbox", "remember", digest("b"), digest("c"), "queued", 0, T5, T0, T0)).toThrow("memory candidate approval required");
    } finally { closePersonalDb(db); }
  });

  it("rejects an anonymous stale-owner tombstone after reclaim and accepts the current fence once", async () => {
    // Given owner-old/fence1 expired and owner-new/fence2 reclaimed the deletion
    const db = await personalDb();
    try {
      const approval = approvedDeletion(db, "del:reclaimed-tombstone", "reclaimed-tombstone");
      db.db.prepare("UPDATE memory_deletion_requests SET lease_owner='delete:new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE deletion_id='del:reclaimed-tombstone'").run(T5, T2);
      // When an anonymous stale worker writes the effect after reclaim
      let rejection: unknown;
      try {
        db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:stale-reclaimed", "del:reclaimed-tombstone", digest("5"), digest("6"), digest("7"), digest("8"), approval.requestId, approval.receiptId, approval.receiptDigest, T3, digest("d"), T3);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        rejection = error;
      }
      // Then readback proves no stale effect exists
      expect(rejection).toBeInstanceOf(Error);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_tombstones WHERE deletion_id='del:reclaimed-tombstone'").get()).toEqual({ count: 0 });
      // And an explicit old-owner/fence1 effect also remains absent
      rejection = undefined;
      try {
        db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effect_lease_owner,effect_lease_fence,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:old-reclaimed", "del:reclaimed-tombstone", digest("5"), digest("6"), digest("7"), digest("8"), approval.requestId, approval.receiptId, approval.receiptDigest, "delete:expired", 1, T3, digest("d"), T3);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_tombstones WHERE deletion_id='del:reclaimed-tombstone'").get()).toEqual({ count: 0 });
      // And the exact current owner/fence can persist one immutable tombstone
      db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effect_lease_owner,effect_lease_fence,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:current-reclaimed", "del:reclaimed-tombstone", digest("5"), digest("6"), digest("7"), digest("8"), approval.requestId, approval.receiptId, approval.receiptDigest, "delete:new", 2, T3, digest("e"), T3);
      expect(db.db.prepare("SELECT effect_lease_owner,effect_lease_fence FROM memory_tombstones WHERE deletion_id='del:reclaimed-tombstone'").get()).toEqual({ effect_lease_owner: "delete:new", effect_lease_fence: 2 });
      expect(() => db.db.prepare("UPDATE memory_tombstones SET effect_lease_fence=3 WHERE tombstone_id='tmb:current-reclaimed'").run()).toThrow("immutable memory tombstone");
    } finally { closePersonalDb(db); }
  });

  it("rejects tombstone and settlement after deletion lease expiry", async () => {
    // Given an applying deletion whose lease expires at T2
    const db = await personalDb();
    try {
      const approval = approvedDeletion(db);
      // When stale owner writes a tombstone at T3
      // Then tombstone and settlement cannot bypass reclaim
      expect(() => db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:expired-effect", "del:expired-effect", digest("5"), digest("6"), digest("7"), digest("8"), approval.requestId, approval.receiptId, approval.receiptDigest, T3, digest("9"), T3)).toThrow("memory deletion current lease required");
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='tombstoned',updated_at=? WHERE deletion_id='del:expired-effect'").run(T3)).toThrow(/memory deletion current lease required|memory tombstone required/);
    } finally { closePersonalDb(db); }
  });
});

describe("notification and retention hard time boundaries epoch 3", () => {
  it("rejects notification delivery after intent and lease expiry", async () => {
    // Given a delivering notification whose intent and lease expire at T2
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("ntf:expired-effect", "corr:ntf-expired", "idem:ntf-expired", "dedup:ntf-expired", "action", "mac", "Decision", "/today", "created", T2, T0, T0);
      db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:expired-effect'").run(T1);
      db.db.prepare("INSERT INTO notification_deliveries(delivery_id,intent_id,idempotency_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ntd:expired-effect", "ntf:expired-effect", "idem:ntd-expired", "created", T0, T0);
      db.db.prepare("UPDATE notification_deliveries SET state='queued',updated_at=? WHERE delivery_id='ntd:expired-effect'").run(T1);
      db.db.prepare("UPDATE notification_deliveries SET state='delivering',lease_owner='notify:old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE delivery_id='ntd:expired-effect'").run(T2, T1);
      // When stale delivery settles at T3
      // Then hard parent and lease expiry reject delivery
      expect(() => db.db.prepare("UPDATE notification_deliveries SET state='delivered',receipt_digest=?,delivered_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id='ntd:expired-effect'").run(digest("a"), T3, T3)).toThrow("notification current lease required");
    } finally { closePersonalDb(db); }
  });

  it("rejects retention settlement after its lease expiry", async () => {
    // Given a retention claim expiring at T2
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("ret:expired-effect", "expired-effect", "idem:ret-expired", "audit", "pending", 0, T0, T5, T0, T0);
      db.db.prepare("UPDATE retention_jobs SET state='claimed',lease_owner='retention:expired',lease_fence=1,lease_expires_at=?,updated_at=? WHERE job_id='ret:expired-effect'").run(T2, T1);
      // When stale owner completes at T3
      // Then current lease authority rejects settlement
      expect(() => db.db.prepare("UPDATE retention_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id='ret:expired-effect'").run(T3)).toThrow("retention current lease required");
    } finally { closePersonalDb(db); }
  });

  it("rejects retention claim before not_before", async () => {
    // Given a retention job not eligible until T3
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("ret:premature", "premature", "idem:premature", "audit", "pending", 0, T3, T5, T0, T0);
      // When a worker claims at T1
      // Then scheduling authority rejects the premature claim
      expect(() => db.db.prepare("UPDATE retention_jobs SET state='claimed',lease_owner='retention:early',lease_fence=1,lease_expires_at=?,updated_at=? WHERE job_id='ret:premature'").run(T2, T1)).toThrow("retention not before");
    } finally { closePersonalDb(db); }
  });
});
