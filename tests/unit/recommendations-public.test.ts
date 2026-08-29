import { describe, expect, it } from "vitest";
import * as jarvis from "../../src/index.js";

describe("Task 18 recommendation public boundary", () => {
  it("exports the recommendation service and stable error contract", () => {
    // Given: the package's public module.
    const publicModule: Readonly<Record<string, unknown>> = jarvis;
    // When: Task 18's public seam is inspected dynamically.
    const service = publicModule["Recommendations"];
    // Then: callers can construct the service without importing private persistence modules.
    expect(typeof service).toBe("function");
    expect(publicModule["RecommendationError"]).toEqual(expect.any(Function));
    expect(publicModule["RECOMMENDATION_ERROR_CODES"]).toEqual(expect.arrayContaining([
      "RECOMMENDATION_INPUT_INVALID",
      "RECOMMENDATION_CONTEXT_STALE",
      "RECOMMENDATION_IDENTITY_CONFLICT",
      "RECOMMENDATION_EVIDENCE_CONFLICT",
      "RECOMMENDATION_TRANSITION_CONFLICT",
      "RECOMMENDATION_SUPERSESSION_CONFLICT",
    ]));
  });
});
