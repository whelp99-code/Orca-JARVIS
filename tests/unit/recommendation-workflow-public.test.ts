import { describe, expect, it } from "vitest";
import * as jarvis from "../../src/index.js";

describe("Task 25 public orchestration boundary", () => {
  it("exports staging and injected approved execution contracts", () => {
    // Given: the package public module.
    const api: Readonly<Record<string, unknown>> = jarvis;

    // When: the Task 25 runtime seams are inspected.
    const stager = api["RecommendationWorkflowStager"];
    const executor = api["ApprovedCommandExecutor"];

    // Then: both machine-consumed constructors are public without exposing a real dispatcher.
    expect(typeof stager).toBe("function");
    expect(typeof executor).toBe("function");
    expect(api["RecommendationWorkflowDispatcher"]).toBeUndefined();
  });
});
