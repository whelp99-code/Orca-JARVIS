import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { initialized } from "../helpers.js";

describe("Task 26 migration 037 closure", () => {
  it("publishes indexed bootstrap and cancellation authority with enforced checks and foreign keys", async () => {
    // Given: one freshly initialized database with all migrations and Task26 bootstrap authority.
    const db = await initialized();
    try {
      // When: the physical schema and invalid boundary writes are inspected.
      const tables = db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
        AND (name LIKE 'recommendation_work_%' OR name='recommendation_verified_outcomes') ORDER BY name`)
        .all() as Array<{ name: string }>;
      const indexes = db.db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
        AND name LIKE 'recommendation_%' AND sql IS NOT NULL ORDER BY name`).all() as Array<{ name: string }>;
      const triggers = db.db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
        AND name LIKE 'recommendation_work_%' ORDER BY name`).all() as Array<{ name: string }>;

      // Then: query surfaces, immutable guards, FK checks, and state-nullability checks are active.
      expect(tables.map(row => row.name)).toEqual(expect.arrayContaining([
        "recommendation_work_verifier_bindings", "recommendation_work_provider_bindings",
        "recommendation_work_runtimes", "recommendation_work_cancel_requests",
        "recommendation_work_dispatch_attempts", "recommendation_work_dispatch_receipts",
        "recommendation_work_progress", "recommendation_work_nonterminal_events",
        "recommendation_work_verification_requests", "recommendation_work_verification_receipts",
        "recommendation_work_negative_evidence", "recommendation_work_settlements",
        "recommendation_verified_outcomes",
      ]));
      expect(indexes.length).toBeGreaterThanOrEqual(12); expect(triggers.length).toBeGreaterThanOrEqual(30);
      expect(db.db.pragma("foreign_key_check")).toEqual([]);
      expect(() => db.db.prepare(`INSERT INTO recommendation_work_provider_bindings(binding_id,key_id,purpose,
        provider,endpoint_scope,public_key_pem,not_before,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run("bad", "bad", "other", "codex", "recommendation-work", "pem",
          "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"))
        .toThrow();
      expect(() => db.db.prepare(`INSERT INTO recommendation_work_cancel_requests(cancel_id,runtime_id,request_json,
        request_digest,reason,lease_fence,state,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run("bad-cancel", "missing-runtime", "{}", `sha256:${"a".repeat(64)}`, "bad", 1,
          "pending", "cancelled", "2026-01-01T00:00:00.000Z")).toThrow();
      for (const table of ["recommendation_work_verifier_bindings", "recommendation_work_provider_bindings"]) {
        expect(() => db.db.prepare(`UPDATE ${table} SET binding_id=binding_id`).run()).toThrow();
        expect(() => db.db.prepare(`DELETE FROM ${table}`).run()).toThrow();
      }

      const filename = db.filename; db.close(); const reopened = new AuthorityDb(filename);
      try {
        await reopened.assertMigrationsReady(); expect(reopened.db.pragma("foreign_key_check")).toEqual([]);
        expect(reopened.db.prepare("SELECT COUNT(*) count FROM recommendation_work_provider_bindings").get())
          .toEqual({ count: 2 });
      } finally { reopened.close(); }
      return;
    } finally {
      if (db.db.open) db.close();
    }
  });
});
