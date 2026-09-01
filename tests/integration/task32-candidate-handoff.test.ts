import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

describe("Task 32 candidate review-to-dispatch handoff", () => {
  it("keeps review and dispatch publication records separate from content authority", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const names = (db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_candidate_%'",
      ).all() as Array<{ readonly name: string }>).map(row => row.name);
      expect(names).toEqual(expect.arrayContaining([
        "memory_candidate_review_publications",
        "memory_candidate_dispatch_publications",
        "memory_candidate_owner_decisions",
      ]));
      expect(names).not.toContain("memory_candidate_review_content");
    } finally {
      db.close();
    }
  });
});
