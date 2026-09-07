import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";

const SLOT = "066_memory_remember_plain_text.sql";
describe("remember V3 publication forward migration", () => {
  it("preserves old publication rows, foreign keys, and immutable identity while admitting only remember V3", async () => {
    const root = mkdtempSync(join(tmpdir(), "remember-v3-migration-"));
    const migrations = join(root, "migrations");
    cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
    for (const name of readdirSync(migrations)) if (name >= SLOT) rmSync(join(migrations, name));
    const db = new AuthorityDb(join(root, "authority.sqlite"), migrations);
    try {
      await db.migrate();
      for (const [index, operation] of ["remember", "correct", "remember"].entries()) {
        db.db.prepare(`INSERT INTO memory_candidates(candidate_id,correlation_id,idempotency_key,candidate_kind,
          operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,state,
          expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`candidate:${index}`, `corr:${index}`,
          `idem:${index}`, "verified_fact", operation, "sha256:subject", "sha256:content", "sha256:source", "normal",
          "personal_memory", 0, "proposed", "2026-09-09T12:00:00.000Z", "2026-09-08T12:00:00.000Z", "2026-09-08T12:00:00.000Z");
      }
      const insert = (index: number, schema: number, operation: string) => db.db.prepare(
        `INSERT INTO memory_candidate_dispatch_publications(candidate_id,schema_version,operation,dispatch_spool_digest,
          target_version_digest,expected_prior_digest,scope_digest,state,published_at,accepted_at,terminal_at)
        VALUES(?,?,?,?,?,?,?,'terminal',?,?,?)`).run(`candidate:${index}`, schema, operation, `digest:${index}`,
        operation === "correct" ? "target" : null, operation === "correct" ? "prior" : null,
        operation === "correct" ? "scope" : null, "published", "accepted", "terminal");
      insert(0, 1, "remember"); insert(1, 2, "correct");
      const before = db.db.prepare("SELECT * FROM memory_candidate_dispatch_publications ORDER BY candidate_id").all();
      expect(() => insert(2, 3, "remember")).toThrow();
      cpSync(join(process.cwd(), "migrations", SLOT), join(migrations, SLOT));
      await db.migrate();
      expect(db.db.prepare("SELECT * FROM memory_candidate_dispatch_publications ORDER BY candidate_id").all()).toEqual(before);
      expect(db.db.pragma("foreign_key_check")).toEqual([]);
      expect(() => insert(2, 3, "correct")).toThrow();
      expect(() => insert(2, 2, "remember")).toThrow();
      insert(2, 3, "remember");
      expect(() => db.db.exec("UPDATE memory_candidate_dispatch_publications SET schema_version=1 WHERE candidate_id='candidate:2'"))
        .toThrow("immutable memory candidate dispatch identity");
      await db.migrate();
      expect(db.db.prepare("SELECT count(*) AS n FROM memory_candidate_dispatch_publications").get()).toEqual({ n: 3 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
