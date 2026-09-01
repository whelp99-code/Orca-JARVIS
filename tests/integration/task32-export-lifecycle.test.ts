import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

describe("Task 32 export lifecycle", () => {
  it("keeps export availability metadata digest-only and monotonic", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const columns = db.db.prepare("PRAGMA table_info(memory_export_lifecycle_observations)").all() as Array<{ readonly name: string }>;
      const names = columns.map(row => row.name);
      expect(names).toEqual(expect.arrayContaining([
        "manifest_digest", "manifest_revision", "scope_digest",
        "tombstone_sequence", "tombstone_set_root", "status_digest",
        "signature_digest", "expires_at",
      ]));
      const triggers = (db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_export_lifecycle_%'",
      ).all() as Array<{ readonly name: string }>).map(row => row.name);
      expect(triggers).toEqual(expect.arrayContaining([
        "memory_export_lifecycle_transition",
        "memory_export_lifecycle_immutable_update",
        "memory_export_lifecycle_immutable_delete",
      ]));
    } finally {
      db.close();
    }
  });
});
