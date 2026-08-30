import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closePersonalDb, digest, migrationCopy, personalDb, removeMigrationCopy, T0, T1, T2, T3, T5 } from "./personal-operations-test-helpers.js";

const notificationStates = ["created", "deferred", "queued", "delivering", "delivered", "suppressed", "failed", "expired"] as const;
const memoryStates = ["proposed", "classified", "awaiting_confirmation", "approved", "queued", "delivering", "accepted_unsettled", "settled", "rejected", "uncertain", "expired"] as const;

function tableSql(db: Awaited<ReturnType<typeof personalDb>>, table: string): string {
  const row = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
  return row.sql;
}

function transitionSql(db: Awaited<ReturnType<typeof personalDb>>, trigger: string): string {
  const row = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger) as { sql: string };
  return row.sql;
}

function tempRootCount(): number {
  return readdirSync(tmpdir()).filter(name => name.startsWith("jarvis-personal-operations-")).length;
}

describe("canonical personal operation states", () => {
  it("publishes only the frozen notification and memory states", async () => {
    // Given the migrated schema
    const db = await personalDb();
    try {
      // When machine-consumed CHECK inventories are read
      const notification = tableSql(db, "notification_intents");
      const delivery = tableSql(db, "notification_deliveries");
      const candidate = tableSql(db, "memory_candidates");
      const outbox = tableSql(db, "memory_outbox");
      // Then exact canonical states are present and reduced local states are absent
      for (const state of notificationStates) { expect(notification).toContain(`'${state}'`); expect(delivery).toContain(`'${state}'`); }
      expect(notification).not.toContain("'proposed'"); expect(delivery).not.toContain("'ready'");
      for (const state of memoryStates) { expect(candidate).toContain(`'${state}'`); expect(outbox).toContain(`'${state}'`); }
      expect(candidate).not.toContain("'failed'"); expect(outbox).not.toContain("'failed'");
    } finally { closePersonalDb(db); }
  });

  it("enumerates the exact notification transition graph", async () => {
    // Given the notification transition trigger
    const db = await personalDb();
    try {
      // When its machine SQL is inspected
      const sql = transitionSql(db, "notification_intents_transition");
      // Then every allowed edge and no direct skip is encoded
      for (const edge of ["created:deferred", "created:queued", "created:suppressed", "created:expired", "deferred:queued", "deferred:suppressed", "deferred:expired", "queued:delivering", "queued:suppressed", "queued:expired", "delivering:delivered", "delivering:failed", "delivering:expired"]) expect(sql).toContain(edge);
      expect(sql).not.toContain("created:delivered");
      expect(sql).not.toContain("queued:delivered");
    } finally { closePersonalDb(db); }
  });

  it("requires accepted_unsettled before memory settlement", async () => {
    // Given a delivering memory outbox with current lease
    const db = await personalDb();
    try {
      db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("memcand:states", "corr:states", "idem:candidate:states", "verified_fact", "remember", digest("1"), digest("2"), digest("3"), "normal", "continuity", 0, "proposed", T5, T0, T0);
      db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id='memcand:states'").run(T1);
      db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id='memcand:states'").run(T1);
      db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:states", "memcand:states", "idem:outbox:states", "remember", digest("4"), digest("5"), "queued", 0, T5, T0, T0);
      db.db.prepare("UPDATE memory_outbox SET state='delivering',lease_owner='worker',lease_fence=1,lease_expires_at=?,updated_at=? WHERE outbox_id='memout:states'").run(T3, T1);
      // When settlement skips provider acceptance
      // Then the canonical transition rejects it
      expect(() => db.db.prepare("UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,settled_at=?,updated_at=? WHERE outbox_id='memout:states'").run(T2, T2)).toThrow("memory outbox transition invalid");
    } finally { closePersonalDb(db); }
  });
});

const malformedTimes = [
  "not-a-date",
  "a",
  "z",
  "2026-08-28T00:00:00",
  "2026-08-28T00:00:00+00:00",
  "2026-02-30T00:00:00.000Z",
] as const;

describe("canonical personal operation timestamps", () => {
  it.each(malformedTimes)("rejects malformed UTC timestamp %s", async timestamp => {
    // Given a fresh migrated database
    const db = await personalDb();
    try {
      // When a daily row carries a malformed timestamp
      // Then canonical UTC persistence fails closed
      expect(() => db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`dlr:${timestamp}`, "2026-08-28", `corr:${timestamp}`, `idem:${timestamp}`, "pending", 0, T5, timestamp, timestamp)).toThrow(/CHECK constraint failed|personal timestamp invalid|daily loop v1 input invalid/g);
    } finally { closePersonalDb(db); }
  });

  it("rejects impossible date and reversed expiry boundaries", async () => {
    // Given a fresh migrated database
    const db = await personalDb();
    try {
      // When impossible loop dates or reversed expiry are inserted
      // Then semantic time checks reject both
      expect(() => db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("dlr:date", "2026-02-30", "corr:date", "idem:date", "pending", 0, T5, T0, T0)).toThrow(/CHECK constraint failed|personal timestamp invalid|daily loop v1 input invalid/g);
      expect(() => db.db.prepare("INSERT INTO retention_jobs(job_id,job_key,idempotency_key,data_class,state,lease_fence,not_before,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("ret:reverse", "reverse", "idem:reverse", "audit", "pending", 0, T2, T1, T0, T0)).toThrow(/CHECK constraint failed|personal timestamp invalid|daily loop v1 input invalid/g);
    } finally { closePersonalDb(db); }
  });
});

describe("expected migration failure cleanup", () => {
  it("removes the personalDb temporary root when migration rejects", async () => {
    // Given a migration copy that deterministically fails
    const directory = migrationCopy();
    const migration = join(directory, "033_personal_operations.sql");
    writeFileSync(migration, `${readFileSync(migration, "utf8")}\nINSERT INTO missing_cleanup_table VALUES (1);\n`);
    const baseline = tempRootCount();
    try {
      // When personalDb migration rejects
      await expect(personalDb(directory)).rejects.toThrow("no such table: missing_cleanup_table");
      // Then no expected-failure root leaks
      expect(tempRootCount()).toBe(baseline);
    } finally { removeMigrationCopy(directory); }
  });
});
