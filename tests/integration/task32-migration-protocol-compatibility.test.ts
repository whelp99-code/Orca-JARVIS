import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

describe("Task 32 migration protocol compatibility", () => {
  it("keeps the forward migration vector contiguous and content-free", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const idRows = db.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ readonly id: string }>;
      const ids = idRows.map(row => row.id);
      expect(ids.at(-1)).toBe("057_memory_candidate_authority_v6.sql");
      expect(ids).toEqual(expect.arrayContaining([
        "052_memory_effect_content_free.sql",
        "053_memory_surface_authority.sql",
        "054_memory_export_lifecycle.sql",
        "055_memory_candidate_authority_v6.sql",
        "056_remote_approval_v2.sql",
        "057_memory_candidate_authority_v6.sql",
      ]));
      const columnRows = db.db.prepare("PRAGMA table_info(memory_outbox)").all() as Array<{ readonly name: string }>;
      expect(columnRows.map(row => row.name)).not.toContain("request_json");
    } finally {
      db.close();
    }
  });
});
