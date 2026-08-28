import { describe, expect, it } from "vitest";
import { closePersonalDb, digest, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

describe("personal operation leased jobs", () => {
  it("allows one daily-loop claimant and rejects a duplicate claimant and stale fence", async () => {
    // Given a pending daily run
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("dlr:one", "2026-08-28", "corr:one", "idem:daily:one", "pending", 0, T5, T0, T0);
      // When worker one claims it
      db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='worker:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id='dlr:one'").run(T2, T1);
      // Then a second active claimant and stale-fence settlement fail closed
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET lease_owner='worker:two',lease_fence=2,lease_expires_at=?,updated_at=? WHERE run_id='dlr:one'").run(T3, T1)).toThrow(/daily loop (active lease exists|stale fence)/);
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET state='running',lease_fence=0,updated_at=? WHERE run_id='dlr:one'").run(T1)).toThrow(/daily loop (active lease exists|reclaim invalid)/);
      db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id='dlr:one'").run(T1);
      db.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id='dlr:one'").run(T1);
      db.db.prepare("UPDATE daily_loop_runs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,result_digest=?,updated_at=? WHERE run_id='dlr:one'").run(digest("a"), T1);
      expect(db.db.prepare("SELECT state,lease_fence FROM daily_loop_runs WHERE run_id='dlr:one'").get()).toEqual({ state: "completed", lease_fence: 1 });
    } finally { closePersonalDb(db); }
  });

  it("persists ordered daily steps and immutable checkpoints", async () => {
    // Given a claimed daily run
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("dlr:steps", "2026-08-28", "corr:steps", "idem:daily:steps", "pending", 0, T5, T0, T0);
      db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='worker',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id='dlr:steps'").run(T3, T1);
      // When its step and checkpoint are persisted
      db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("dls:one", "dlr:steps", 1, "morning", "pending", T1, T1);
      for (const state of ["claimed", "running", "verifying", "completed"] as const) db.db.prepare("UPDATE daily_loop_steps SET state=?,evidence_digest=?,result_digest=?,updated_at=? WHERE step_id='dls:one'").run(state, digest("b"), digest("c"), T1);
      db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("dlc:one", "dlr:steps", "dls:one", 1, "running", null, digest("d"), 1, T3, T1);
      // Then duplicate sequence and checkpoint mutation fail
      expect(() => db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("dls:two", "dlr:steps", 1, "evening", "pending", T1, T1)).toThrow(/UNIQUE constraint failed/);
      expect(() => db.db.prepare("UPDATE daily_loop_checkpoints SET state='completed' WHERE checkpoint_id='dlc:one'").run()).toThrow("immutable daily loop checkpoint");
    } finally { closePersonalDb(db); }
  });

  it("delivers one redacted notification under one fenced attempt", async () => {
    // Given a ready redacted notification intent
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("ntf:one", "corr:notification", "idem:notification:one", "dedup:one", "action", "mac", "Decision available", "/today/decision/one", "created", T5, T0, T0);
      db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:one'").run(T1);
      // When a delivery is claimed and settled
      db.db.prepare("INSERT INTO notification_deliveries(delivery_id,intent_id,idempotency_key,state,attempt_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("ntd:one", "ntf:one", "idem:delivery:one", "created", digest("e"), T1, T1);
      db.db.prepare("UPDATE notification_deliveries SET state='queued',updated_at=? WHERE delivery_id='ntd:one'").run(T1);
      db.db.prepare("UPDATE notification_deliveries SET state='delivering',lease_owner='mac:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE delivery_id='ntd:one'").run(T3, T1);
      db.db.prepare("UPDATE notification_deliveries SET state='delivered',receipt_digest=?,delivered_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE delivery_id='ntd:one' AND lease_fence=1").run(digest("f"), T2, T2);
      db.db.prepare("UPDATE notification_intents SET state='delivering',updated_at=? WHERE intent_id='ntf:one'").run(T1);
      db.db.prepare("UPDATE notification_intents SET state='delivered',updated_at=? WHERE intent_id='ntf:one'").run(T2);
      // Then duplicate semantic delivery and stale settlement fail
      expect(() => db.db.prepare("INSERT INTO notification_deliveries(delivery_id,intent_id,idempotency_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ntd:two", "ntf:one", "idem:delivery:one", "created", T2, T2)).toThrow(/UNIQUE constraint failed/);
      expect(db.db.prepare("UPDATE notification_deliveries SET state='failed',updated_at=? WHERE delivery_id='ntd:one' AND lease_fence=0").run(T2).changes).toBe(0);
    } finally { closePersonalDb(db); }
  });

  it("rejects skipped initial and mutable job transitions", async () => {
    // Given a migrated personal operations schema
    const db = await personalDb();
    try {
      // When callers skip initial or intermediate states
      const daily = db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)");
      const intent = db.db.prepare("INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
      const retention = db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
      // Then each state machine fails closed
      expect(() => daily.run("dlr:skip", "2026-08-28", "corr:skip", "idem:daily:skip", "completed", 0, T5, T0, T0)).toThrow("daily loop must start pending");
      expect(() => intent.run("ntf:skip", "corr:skip", "idem:notification:skip", "dedup:skip", "info", "mac", "safe", "/today", "delivered", T5, T0, T0)).toThrow("notification must start created");
      expect(() => retention.run("ret:skip", "skip", "idem:retention:skip", "audit", "completed", 0, T0, T5, T0, T0)).toThrow("retention must start pending");
    } finally { closePersonalDb(db); }
  });

  it("fences a retention job through completion", async () => {
    // Given one pending semantic retention job
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("ret:one", "notification:2026-08-28", "idem:retention:one", "notification", "pending", 0, T0, T5, T0, T0);
      // When worker one claims the job
      db.db.prepare("UPDATE retention_jobs SET state='claimed',lease_owner='retention:one',lease_fence=1,lease_expires_at=?,updated_at=? WHERE job_id='ret:one'").run(T3, T1);
      // Then duplicate claim fails and the current fence can complete
      expect(() => db.db.prepare("UPDATE retention_jobs SET lease_owner='retention:two',lease_fence=2,lease_expires_at=?,updated_at=? WHERE job_id='ret:one'").run(T4, T2)).toThrow(/retention (active lease exists|stale fence)/);
      db.db.prepare("UPDATE retention_jobs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id='ret:one'").run(digest("1"), T2);
      expect(db.db.prepare("SELECT state,lease_fence FROM retention_jobs WHERE job_id='ret:one'").get()).toEqual({ state: "completed", lease_fence: 1 });
    } finally { closePersonalDb(db); }
  });
});
