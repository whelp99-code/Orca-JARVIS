import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 migration allocation", () => {
  it("allocates a new forward-only migration for the content-free rebuild", () => {
    const path = "migrations/057_memory_candidate_authority_v6.sql";
    expect(existsSync(path)).toBe(true);
    const migration = readFileSync(path, "utf8");
    expect(migration).toContain("CREATE TABLE memory_outbox");
    expect(migration).toContain("DROP TABLE memory_outbox_v6_contentful");
    expect(migration).not.toContain("ALTER TABLE memory_outbox");
  });
});
