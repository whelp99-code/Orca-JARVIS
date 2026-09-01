import { describe, expect, it } from "vitest";
import { projectMemoryRecord } from "../../src/dashboard/memory-redaction.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { TASK32_NOW, task32Evidence } from "../fixtures/task32-memory-test-support.js";

describe("Task 32 Memory projection redaction", () => {
  it("keeps authority identities out of public records and redacts restricted content", () => {
    const tokens = new MemoryTokenCache(Buffer.alloc(32, 9), () => TASK32_NOW);
    const value = projectMemoryRecord({
      evidence: task32Evidence({ sensitivity: "restricted", excerpt: "private statement" }),
      tokens,
      sessionId: "owner-session",
      privacyEpoch: 0,
      now: TASK32_NOW,
    });

    expect(value).toMatchObject({
      title: "[REDACTED]",
      excerpt: null,
      citation: "Private citation",
      actions: ["forget", "export"],
    });
    expect(JSON.stringify(value)).not.toContain("source_identity_full");
    expect(JSON.stringify(value)).not.toContain("private statement");
  });
});
