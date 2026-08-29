import { describe, expect, it } from "vitest";

describe("Task 16 public context policy", () => {
  it("exports the deterministic context policy through the loadable package API", async () => {
    // Given: the loadable public package API.
    const publicApi = await import("../../src/index.js");
    // When: the Task 16 policy seam is inspected dynamically.
    const exported = "evaluateContextPolicy" in publicApi;
    // Then: callers can evaluate evidence without a static missing-import failure.
    expect(exported).toBe(true);
  });
});
