import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const OLD = "http://jm-acloud.alpines-goldeye.ts.net:3010/#m=41";
const NEW = "https://jm-omachy.alpines-goldeye.ts.net:8451/#m=41";

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve("migrations/099_workboard_projection.sql"), "utf8"));
  db.prepare(
    `INSERT INTO workboard_works(
      work_id, session_key, session_id, task_id, source_key, sequence, state, summary,
      evidence_ref, source_at, received_at, attempt_key)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "w1", "s1", "msg:41", "41", "mail:reply-gap", 1, "waiting", "회신: test",
    OLD, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "a1",
  );
  db.exec(readFileSync(resolve("migrations/106_workboard_reply_gap_evidence_host.sql"), "utf8"));
  return db;
}

describe("workboard reply-gap evidence_ref host migration", () => {
  it("rewrites jm-acloud evidence_ref and preserves rollback rows", () => {
    const db = migratedDb();
    const row = db.prepare("SELECT evidence_ref FROM workboard_works WHERE work_id=?").get("w1") as { evidence_ref: string };
    expect(row.evidence_ref).toBe(NEW);
    const prior = db.prepare(
      "SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 WHERE work_id=?",
    ).get("w1") as { prior_evidence_ref: string };
    expect(prior.prior_evidence_ref).toBe(OLD);
    db.prepare(
      `UPDATE workboard_works SET evidence_ref = (
         SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 r
         WHERE r.work_id = workboard_works.work_id
       ) WHERE work_id = ?`,
    ).run("w1");
    const rolled = db.prepare("SELECT evidence_ref FROM workboard_works WHERE work_id=?").get("w1") as { evidence_ref: string };
    expect(rolled.evidence_ref).toBe(OLD);
    db.close();
  });
});
