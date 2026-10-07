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
      const prefixes = [...new Set(ids.map(id => Number(id.slice(0, 3))))];
      expect(prefixes).toEqual(Array.from({ length: prefixes.length }, (_, index) => index + 1));
      // Both published histories must retain their filenames and checksums. Only
      // these nine pinned history collisions are permitted; new duplicates fail.
      const duplicates = prefixes.map(prefix => ids.filter(id => Number(id.slice(0, 3)) === prefix))
        .filter(group => group.length > 1);
      expect(duplicates).toEqual([
        ["028_budgeted_evolution_memory.sql", "028_negative_evidence.sql"],
        ["072_daemon_runtime_identity.sql", "072_memory_correction_cancellation.sql"],
        ["073_memory_cancellation_results.sql", "073_native_evening_publications.sql"],
        ["074_memory_cancellation_material.sql", "074_retention_policy_binding.sql"],
        ["075_daily_event_identity.sql", "075_memory_cancellation_local_compaction.sql"],
        ["079_memory_scoped_completion_observations.sql", "079_task_execution_read_indexes.sql"],
        ["080_memory_late_subject_suppression.sql", "080_memory_scoped_settlements.sql"],
        ["097_core5_integration_operations.sql", "097_memory_deletion_terminal_refusal.sql"],
        ["098_core5_mail_draft_refs.sql", "098_morning_refresh_subscription.sql", "098_owner_decision_key_enrollment.sql"],
        // Published parallel histories. Renumbering would rewrite applied production migrations.
        // 099: ee21fe5 / 7cb1d7c. 100: 9c7535a / deb14c2. 101: a654612 / deb14c2.
        ["099_provider_tombstone_replica.sql", "099_workboard_projection.sql"],
        ["100_memory_outbox_not_delivered.sql", "100_workboard_purpose.sql"],
        ["101_owner_inbox_webauthn.sql", "101_workboard_attention.sql"],
      ]);
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
