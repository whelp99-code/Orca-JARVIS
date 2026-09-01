import { describe, expect, it } from "vitest";
import { MEMORY_ERROR_CODES, MEMORY_TOPICS } from "../../src/dashboard/memory-contracts.js";

describe("Task 32 Memory public contract", () => {
  it("declares the six refresh topics and strict body-size error", () => {
    expect(MEMORY_TOPICS).toEqual([
      "memory.records.v1",
      "memory.conflicts.v1",
      "memory.candidates.v1",
      "memory.effects.v1",
      "memory.privacy.v1",
      "memory.status.v1",
    ]);
    expect(MEMORY_ERROR_CODES).toContain("MEMORY_REQUEST_TOO_LARGE");
  });
});
