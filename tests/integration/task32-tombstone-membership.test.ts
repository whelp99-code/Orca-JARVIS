import { describe, expect, it } from "vitest";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { TASK32_NOW, task32Evidence } from "../fixtures/task32-memory-test-support.js";

describe("Task 32 tombstone membership", () => {
  it("binds the high-water tombstone sequence and root into a selection", () => {
    const cache = new MemoryTokenCache(Buffer.alloc(32, 6), () => TASK32_NOW);
    const issued = cache.issue(task32Evidence({ tombstoneSequence: 7 }), "owner-session", 2);
    expect(issued).toBeDefined();
    if (issued === undefined) return;
    const selected = cache.get(issued.token, "owner-session", 2);
    expect(selected).toMatchObject({
      tombstone_sequence: 7,
      tombstone_set_root: `sha256:${"3".repeat(64)}`,
    });
  });
});
