import { describe, expect, it } from "vitest";

describe("Task 14 public observation normalizer", () => {
  it("exports the normalizer through the package public API", async () => {
    // Given: the loadable public package API.
    const publicApi = await import("../../src/index.js");
    // When: the Task 14 normalizer seam is inspected.
    const exported = "normalizePersonalObservations" in publicApi;
    // Then: callers can normalize structured live evidence.
    expect(exported).toBe(true);
  });
});
