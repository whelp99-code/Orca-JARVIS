import { describe, expect, it } from "vitest";

describe("Task 15 public context assembler", () => {
  it("exports the assembler through the loadable package API", async () => {
    // Given: the loadable public package API.
    const publicApi = await import("../../src/index.js");
    // When: the Task 15 assembler seam is inspected.
    const exported = "assemblePersonalContext" in publicApi;
    // Then: callers can assemble a provenance-safe snapshot.
    expect(exported).toBe(true);
  });
});
