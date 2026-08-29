import { describe, expect, it } from "vitest";

describe("Task 19 longitudinal evaluator public seam", () => {
  it("exports the corpus parser and evaluator through the loadable package API", async () => {
    // Given: the shipped package API
    const api: Record<string, unknown> = await import("../../src/index.js");

    // When: Task 19 exports are inspected
    const exports = [api["parsePersonalOsCorpus"], api["evaluatePersonalOsCorpus"], api["runPersonalOsCorpus"],
      api["scorePersonalOsResults"], api["computePersonalOsRecordDigest"]];

    // Then: runner, scorer, parser, evaluator, and immutable binding are public
    expect(exports).toEqual(new Array(5).fill(expect.any(Function)));
  });
});
