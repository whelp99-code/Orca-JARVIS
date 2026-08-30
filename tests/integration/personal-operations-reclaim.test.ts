import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, insertApproval, insertDailyRun, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

function candidateOutbox(db: AuthorityDb): void {
  db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("memcand:reclaim", "corr:memory", "idem:candidate", "verified_fact", "remember", digest("1"), digest("2"), digest("3"), "normal", "continuity", 0, "proposed", T5, T0, T0);
  db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id='memcand:reclaim'").run(T1);
  db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id='memcand:reclaim'").run(T1);
  db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:reclaim", "memcand:reclaim", "idem:outbox", "remember", digest("4"), digest("5"), "queued", 0, T5, T0, T0);
}

function requestedDeletion(db: AuthorityDb): void {
  const identity = { deletion_id: "del:reclaim", subject_digest: digest("6"), scope_digest: digest("7"), target_digest: digest("8") };
  const approval = insertApproval(db, { suffix: "delete-reclaim", action: "memory.delete", target: identity, args: { operation: "forget", args_digest: digest("9") } });
  db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(identity.deletion_id, "corr:delete", "idem:delete", "forget", identity.subject_digest, identity.scope_digest, identity.target_digest, digest("9"), "local-owner", "requested", 0, T5, T0, T0);
  db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,updated_at=? WHERE deletion_id=?").run(approval.requestId, approval.receiptId, approval.receiptDigest, T1, identity.deletion_id);
  db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, identity.deletion_id);
}

describe("expired lease atomic reclaim", () => {
  it("rejects a skipped fence during expired daily reclaim", async () => {
    // Given an expired daily claim at fence one
    const db = await personalDb();
    try {
      insertDailyRun(db, { runId: "dlr:skip-fence", correlation: "corr:skip-fence", idempotency: "idem:skip-fence" });
      db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id='dlr:skip-fence'").run(T2, T1);
      // When reclaim skips fence two
      // Then exact monotonic reclaim fails
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET lease_owner='new',lease_fence=3,lease_expires_at=?,updated_at=? WHERE run_id='dlr:skip-fence'").run(T5, T3)).toThrow(/daily loop (reclaim|lease mutation) invalid/);
    } finally { closePersonalDb(db); }
  });

  it("reclaims an expired daily run and fences the old owner", async () => {
    // Given a daily run claimed through T2
    const db = await personalDb();
    try {
      insertDailyRun(db, { runId: "dlr:reclaim", correlation: "corr:daily", idempotency: "idem:daily" });
      db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id='dlr:reclaim'").run(T2, T1);
      // When a second owner reclaims strictly after expiry
      db.db.prepare("UPDATE daily_loop_runs SET lease_owner='new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE run_id='dlr:reclaim'").run(T5, T3);
      // Then old heartbeat/settlement lose and the new fence advances
      expect(db.db.prepare("UPDATE daily_loop_runs SET lease_expires_at=?,updated_at=? WHERE run_id='dlr:reclaim' AND lease_owner='old' AND lease_fence=1").run(T4, T3).changes).toBe(0);
      expect(db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id='dlr:reclaim' AND lease_owner='old' AND lease_fence=1").run(T3).changes).toBe(0);
      expect(db.db.prepare("SELECT state,lease_owner,lease_fence FROM daily_loop_runs WHERE run_id='dlr:reclaim'").get()).toEqual({ state: "claimed", lease_owner: "new", lease_fence: 2 });
    } finally { closePersonalDb(db); }
  });

  it("rejects a notification duplicate claimant then permits expired reclaim", async () => {
    // Given a delivering notification lease through T2
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("ntf:reclaim", "corr:notification", "idem:intent", "dedup:reclaim", "action", "mac", "Decision", "/today", "created", T5, T0, T0);
      db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:reclaim'").run(T1);
      db.db.prepare("INSERT INTO notification_deliveries(delivery_id,intent_id,idempotency_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ntd:reclaim", "ntf:reclaim", "idem:delivery", "created", T0, T0);
      db.db.prepare("UPDATE notification_deliveries SET state='queued',updated_at=? WHERE delivery_id='ntd:reclaim'").run(T1);
      db.db.prepare("UPDATE notification_deliveries SET state='delivering',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE delivery_id='ntd:reclaim'").run(T2, T1);
      // When duplicate and expired reclaim claims race
      // Then current duplicate fails while strict-expiry reclaim succeeds
      expect(() => db.db.prepare("UPDATE notification_deliveries SET lease_owner='other',lease_fence=2,lease_expires_at=?,updated_at=? WHERE delivery_id='ntd:reclaim'").run(T4, T1)).toThrow("notification active lease exists");
      db.db.prepare("UPDATE notification_deliveries SET lease_owner='new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE delivery_id='ntd:reclaim'").run(T5, T3);
      expect(db.db.prepare("UPDATE notification_deliveries SET state='delivered',receipt_digest=?,delivered_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id='ntd:reclaim' AND lease_owner='old' AND lease_fence=1").run(digest("a"), T3, T3).changes).toBe(0);
      expect(db.db.prepare("UPDATE notification_deliveries SET state='delivered',receipt_digest=?,delivered_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id='ntd:reclaim' AND lease_owner='new' AND lease_fence=2").run(digest("b"), T3, T3).changes).toBe(1);
    } finally { closePersonalDb(db); }
  });

  it("reclaims memory delivery without accepting old-fence reconciliation", async () => {
    // Given an expired delivering memory outbox
    const db = await personalDb();
    try {
      candidateOutbox(db);
      db.db.prepare("UPDATE memory_outbox SET state='delivering',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE outbox_id='memout:reclaim'").run(T2, T1);
      db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:old", "memout:reclaim", 1, digest("a"), "uncertain", T1);
      // When a new worker reclaims after expiry
      db.db.prepare("UPDATE memory_outbox SET lease_owner='new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE outbox_id='memout:reclaim'").run(T5, T3);
      // Then the old fence cannot reconcile and the new accepted-unsettled path can settle
      expect(() => db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?,?)").run("memrec:old", "memout:reclaim", "mema:old", 1, "artifact_observed", digest("5"), digest("b"), T3)).toThrow("memory outbox current fence required");
      db.db.prepare("INSERT INTO memory_outbox_attempts(attempt_id,outbox_id,lease_fence,invocation_digest,outcome,created_at) VALUES(?,?,?,?,?,?)").run("mema:new", "memout:reclaim", 2, digest("c"), "accepted", T3);
      db.db.prepare("UPDATE memory_outbox SET state='accepted_unsettled',updated_at=? WHERE outbox_id='memout:reclaim' AND lease_owner='new' AND lease_fence=2").run(T3);
      db.db.prepare("INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at) VALUES(?,?,?,?,?,?,?,?)").run("memrec:new", "memout:reclaim", "mema:new", 2, "artifact_observed", digest("5"), digest("d"), T3);
      expect(db.db.prepare("UPDATE memory_outbox SET state='settled',settled_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE outbox_id='memout:reclaim' AND lease_owner='new' AND lease_fence=2").run(T3, T3).changes).toBe(1);
    } finally { closePersonalDb(db); }
  });

  it("reclaims expired deletion and retention leases with exactly next fence", async () => {
    // Given expired deletion and retention claims
    const db = await personalDb();
    try {
      requestedDeletion(db);
      db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id='del:reclaim'").run(T2, T1);
      db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("ret:reclaim", "reclaim", "idem:retention", "delete", "pending", 0, T0, T5, T0, T0);
      db.db.prepare("UPDATE retention_jobs SET state='claimed',lease_owner='old',lease_fence=1,lease_expires_at=?,updated_at=? WHERE job_id='ret:reclaim'").run(T2, T1);
      // When both are reclaimed after strict expiry
      db.db.prepare("UPDATE memory_deletion_requests SET lease_owner='new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE deletion_id='del:reclaim'").run(T5, T3);
      db.db.prepare("UPDATE retention_jobs SET lease_owner='new',lease_fence=2,lease_expires_at=?,updated_at=? WHERE job_id='ret:reclaim'").run(T5, T3);
      // Then skipped fences and old-fence settlement fail
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET lease_fence=4,updated_at=? WHERE deletion_id='del:reclaim'").run(T4)).toThrow(/memory deletion (active lease exists|reclaim invalid)/);
      expect(db.db.prepare("UPDATE retention_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id='ret:reclaim' AND lease_owner='old' AND lease_fence=1").run(T3).changes).toBe(0);
      expect(db.db.prepare("UPDATE retention_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id='ret:reclaim' AND lease_owner='new' AND lease_fence=2").run(T3).changes).toBe(1);
    } finally { closePersonalDb(db); }
  });
});
