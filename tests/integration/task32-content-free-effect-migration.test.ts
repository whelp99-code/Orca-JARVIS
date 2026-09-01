import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

describe("Task 32 content-free effect migration", () => {
  it("removes request JSON from the final authority schema", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const columns = db.db.prepare("PRAGMA table_info(memory_outbox)").all() as Array<{ readonly name: string }>;
      const names = columns.map(row => row.name);
      expect(names).not.toContain("request_json");
      expect(names).toContain("request_digest");
      expect(names).toContain("expected_artifact_digest");
    } finally {
      db.close();
    }
  });
});
