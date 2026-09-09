import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GRAMMAR = /^(?<id>[0-9]{3})_(?<slug>[a-z0-9]+(?:_[a-z0-9]+)*)[.]sql$/;

describe("task 35 migration allocation grammar", () => {
  it("keeps contiguous grammar-matching migration files including 056", () => {
    const files = readdirSync("migrations").filter(name => name.endsWith(".sql")).sort();
    const ids = files.map(name => {
      const match = GRAMMAR.exec(name);
      expect(match, name).not.toBeNull();
      return Number(match?.groups?.id);
    });
    const prefixes = [...new Set(ids)];
    expect(prefixes).toEqual(Array.from({ length: prefixes.length }, (_, index) => index + 1));
    // Preserve both immutable published histories; reject any unlisted collision.
    expect(prefixes.map(prefix => files.filter((_, index) => ids[index] === prefix))
      .filter(group => group.length > 1)).toEqual([
      ["028_budgeted_evolution_memory.sql", "028_negative_evidence.sql"],
      ["072_daemon_runtime_identity.sql", "072_memory_correction_cancellation.sql"],
      ["073_memory_cancellation_results.sql", "073_native_evening_publications.sql"],
      ["074_memory_cancellation_material.sql", "074_retention_policy_binding.sql"],
      ["075_daily_event_identity.sql", "075_memory_cancellation_local_compaction.sql"],
      ["079_memory_scoped_completion_observations.sql", "079_task_execution_read_indexes.sql"],
      ["080_memory_late_subject_suppression.sql", "080_memory_scoped_settlements.sql"],
    ]);
    expect(files).toContain("056_remote_approval_v2.sql");
  });
});
