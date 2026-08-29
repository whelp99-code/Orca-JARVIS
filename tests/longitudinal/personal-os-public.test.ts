import { describe, expect, it } from "vitest";

describe("Task 19 longitudinal evaluator public seam", () => {
  it("exports the corpus parser and evaluator through the loadable package API", async () => {
    // Given: the shipped package API
    const api: Record<string, unknown> = await import("../../src/index.js");

    // When: Task 19 exports are inspected
    const exports = [api["parsePersonalOsCorpus"], api["evaluatePersonalOsCorpus"]];

    // Then: both machine-consumed functions are public
    expect(exports).toEqual([expect.any(Function), expect.any(Function)]);
  });
});
