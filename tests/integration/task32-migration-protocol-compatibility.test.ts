import { readdirSync } from "node:fs";
import { join } from "node:path";
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
      const shipped = readdirSync(join(process.cwd(), "migrations")).filter(file => file.endsWith(".sql")).sort();
      expect(ids).toEqual(shipped);
      expect(ids.map(id => Number(id.slice(0, 3)))).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
      expect(ids).toEqual(expect.arrayContaining([
        "052_memory_effect_content_free.sql",
        "053_memory_surface_authority.sql",
        "054_memory_export_lifecycle.sql",
        "055_memory_candidate_authority_v6.sql",
        "056_remote_approval_v2.sql",
        "057_memory_candidate_authority_v6.sql",
        "058_task_execution_binding.sql",
        "059_task_candidate_artifacts.sql",
        "060_memory_outbox_control_cursor.sql",
        "061_task_execution_clock.sql",
        "062_task_candidate_certifications.sql",
        "063_task_git_publications.sql",
        "064_task_completions.sql",
      ]));
      const columnRows = db.db.prepare("PRAGMA table_info(memory_outbox)").all() as Array<{ readonly name: string }>;
      expect(columnRows.map(row => row.name)).not.toContain("request_json");
    } finally {
      db.close();
    }
  });
});
