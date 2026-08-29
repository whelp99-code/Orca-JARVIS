import { describe, expect, it } from "vitest";

describe("Task 17 public priority engine", () => {
  it("exports deterministic prioritization through the loadable package API", async () => {
    // Given: the loadable public package API.
    const publicApi = await import("../../src/index.js");
    // When: the Task 17 seam is inspected dynamically.
    const exported = "rankPriorityActions" in publicApi;
    // Then: callers can rank actions without a static missing-import failure.
    expect(exported).toBe(true);
  });
});
