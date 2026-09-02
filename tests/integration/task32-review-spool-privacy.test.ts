import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 review spool privacy", () => {
  it("keeps candidate content in the private spool and stores only digests in SQLite", () => {
    const spool = readFileSync("src/memory-candidate-review-spool.ts", "utf8");
    const migration = readFileSync("migrations/057_memory_candidate_authority_v6.sql", "utf8");
    expect(spool).toContain("statement");
    expect(spool).toContain("openPrivateSpoolRoot");
    expect(migration).not.toContain("request_json");
    expect(migration).not.toContain("statement TEXT");
  });
});
