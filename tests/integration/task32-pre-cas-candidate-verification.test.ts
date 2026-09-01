import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 pre-CAS candidate verification", () => {
  it("binds dispatch publication to the review digest and operation", () => {
    const source = readFileSync("src/memory-candidate-dispatch-spool.ts", "utf8");
    expect(source).toContain("MEMORY_DISPATCH_REVIEW_INTEGRITY_FAILURE");
    expect(source).toContain("MEMORY_DISPATCH_OPERATION_MISMATCH");
    expect(source).toContain("memoryCandidateReviewDigest");
  });
});
