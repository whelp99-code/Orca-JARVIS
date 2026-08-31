import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, personalDb, T0, T1, T5 } from "./personal-operations-test-helpers.js";

function insertCandidate(db: AuthorityDb, id: string): void {
  db.db.prepare("INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `corr:${id}`, `idem:${id}`, "verified_fact", "remember", digest("a"), digest("b"), digest("c"), "normal", "continuity", 0, "proposed", T5, T0, T0);
  db.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?").run(T1, id);
  db.db.prepare("UPDATE memory_candidates SET state='approved',updated_at=? WHERE candidate_id=?").run(T1, id);
}

describe("memory outbox persistence", () => {
  it("rejects every outbox row that bypasses the V2 approved action", async () => {
    const db = await personalDb();
    try {
      insertCandidate(db, "memcand:one");
      expect(() => db.db.prepare("INSERT INTO memory_outbox(outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("memout:one", "memcand:one", "idem:send:one", "remember", digest("d"), digest("e"), "queued", 0, T5, T0, T0)).toThrow("memory candidate approval required");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM memory_outbox").get() as { n: number }).n).toBe(0);
    } finally { closePersonalDb(db); }
  });

  it("publishes one immutable V2 attempt and exact reconciliation-fence columns", async () => {
    const db = await personalDb();
    try {
      const attempts = (db.db.prepare("PRAGMA table_info(memory_outbox_attempts)").all() as Array<{ name: string }>).map(row => row.name);
      const events = (db.db.prepare("PRAGMA table_info(memory_reconciliation_events)").all() as Array<{ name: string }>).map(row => row.name);
      expect(attempts).toContain("dispatch_fence"); expect(attempts).not.toContain("lease_fence");
      expect(events).toContain("reconcile_fence"); expect(events).not.toContain("lease_fence");
      const indexes = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_outbox_attempts'").all() as Array<{ name: string }>).map(row => row.name);
      expect(indexes).toContain("memory_outbox_v2_one_attempt");
    } finally { closePersonalDb(db); }
  });

  it("publishes dedicated deletion proof states and read-only tombstone compatibility", async () => {
    const db = await personalDb();
    try {
      const deletion = String((db.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_deletion_requests'",
      ).get() as { readonly sql: string }).sql);
      for (const state of ["requested", "approved", "suppressed", "queued", "applying",
        "reconciling", "provider_proved", "settled"]) expect(deletion).toContain(`'${state}'`);
      expect(deletion).not.toContain("tombstoned");
      expect(db.db.prepare(
        "SELECT type FROM sqlite_master WHERE name='memory_tombstones'",
      ).get()).toEqual({ type: "view" });
      expect(() => db.db.prepare("DELETE FROM memory_tombstones").run()).toThrow();
    } finally { closePersonalDb(db); }
  });
});
