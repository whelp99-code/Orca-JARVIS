import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { projectMailReplyGaps } from "../../src/workboard/adapters/mail-reply-gap.js";
import { WorkboardStore } from "../../src/workboard/store.js";

const OLD = "http://jm-acloud.alpines-goldeye.ts.net:3010/#m=41";
const NEW = "https://jm-omachy.alpines-goldeye.ts.net:8451/#m=41";

function migratedDb(evidenceRef = OLD): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(resolve("migrations/099_workboard_projection.sql"), "utf8"));
  db.prepare(
    `INSERT INTO workboard_works(
      work_id, session_key, session_id, task_id, source_key, sequence, state, summary,
      evidence_ref, source_at, received_at, attempt_key)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "w1", "s1", "msg:41", "41", "mail:reply-gap", 1, "waiting", "회신: test",
    evidenceRef, "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "a1",
  );
  db.exec(readFileSync(resolve("migrations/106_workboard_reply_gap_evidence_host.sql"), "utf8"));
  return db;
}

describe("workboard reply-gap evidence_ref host migration", () => {
  it.each([
    "http://100.87.81.57:3010",
    "https://100.87.81.57:3010",
    "http://100.87.81.57:8451",
    "https://100.87.81.57:8451",
    "https://jm-acloud.alpines-goldeye.ts.net:3010",
    "http://jm-acloud.alpines-goldeye.ts.net:8451",
    "https://jm-acloud.alpines-goldeye.ts.net:8451",
  ])("remaps %s while retaining the path, query, fragment and rollback value", origin => {
    const suffix = "/mail?view=sent&legacy=100.87.81.57&host=jm-acloud.alpines-goldeye.ts.net#m=41";
    const original = `${origin}${suffix}`;
    const db = migratedDb(original);
    try {
      expect(db.prepare("SELECT evidence_ref FROM workboard_works WHERE work_id=?").get("w1"))
        .toEqual({ evidence_ref: `https://jm-omachy.alpines-goldeye.ts.net:8451${suffix}` });
      expect(db.prepare(
        "SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 WHERE work_id=?",
      ).get("w1")).toEqual({ prior_evidence_ref: original });
      db.exec(`UPDATE workboard_works SET evidence_ref = (
        SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 r
        WHERE r.work_id = workboard_works.work_id
      ) WHERE work_id IN (SELECT work_id FROM workboard_evidence_ref_host_remap_20261016)`);
      expect(db.prepare("SELECT evidence_ref FROM workboard_works WHERE work_id=?").get("w1"))
        .toEqual({ evidence_ref: original });
    } finally {
      db.close();
    }
  });

  it("leaves unrelated evidence outside the rollback ledger", () => {
    const original = "https://unrelated.example/mail?view=sent#m=41";
    const db = migratedDb(original);
    try {
      expect(db.prepare("SELECT evidence_ref FROM workboard_works WHERE work_id=?").get("w1"))
        .toEqual({ evidence_ref: original });
      expect(db.prepare("SELECT * FROM workboard_evidence_ref_host_remap_20261016").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("commits reply-gap closure with AuthorityDb foreign keys on and retains rollback evidence", () => {
    const authority = new AuthorityDb(":memory:");
    try {
      const board = new WorkboardStore(authority.db);
      authority.db.exec(readFileSync(resolve("migrations/101_workboard_attention.sql"), "utf8"));
      expect(authority.db.pragma("foreign_keys", { simple: true })).toBe(1);
      projectMailReplyGaps(board, {
        observedAt: "2026-10-01T00:00:00.000Z",
        open: [{ id: "41", subject: "reply", receivedAt: "2026-10-01T00:00:00.000Z" }],
      });
      authority.db.prepare("UPDATE workboard_works SET evidence_ref=?").run(OLD);
      authority.db.exec(readFileSync(resolve("migrations/106_workboard_reply_gap_evidence_host.sql"), "utf8"));

      const result = projectMailReplyGaps(board, {
        observedAt: "2026-10-01T00:15:00.000Z",
        open: [],
      });

      expect(result.closed).toBe(1);
      expect(authority.db.prepare("SELECT * FROM workboard_works").all()).toEqual([]);
      expect(authority.db.prepare("SELECT * FROM workboard_attention").all()).toEqual([]);
      expect(authority.db.prepare("SELECT COUNT(*) AS n FROM workboard_events").get()).toEqual({ n: 2 });
      expect(authority.db.prepare(
        "SELECT last_successful_observation FROM workboard_sources",
      ).get()).toEqual({ last_successful_observation: "2026-10-01T00:15:00.000Z" });
      expect(authority.db.prepare(
        "SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016",
      ).all()).toEqual([{ prior_evidence_ref: OLD }]);
      expect(authority.db.pragma("foreign_key_list(workboard_evidence_ref_host_remap_20261016)"))
        .toEqual([]);
      expect(authority.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      authority.close();
    }
  });

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
