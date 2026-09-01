import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 operation-discriminated candidate dispatch", () => {
  it("keeps remember v1 and correct v2 envelopes distinct", () => {
    const source = readFileSync("src/memory-candidate-dispatch-spool.ts", "utf8");
    expect(source).toContain('schema_version: 1 as const');
    expect(source).toContain('schema_version: 2 as const');
    expect(source).toContain('operation: "correct"');
    expect(source).toContain("target_version_digest");
  });
});
