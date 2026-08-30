import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";

describe("Task 22 public API", () => {
  it("exports the parser, projector, policy, store, and push service through the package barrel", () => {
    // Given/When: the package API is loaded.
    // Then: all Task 22 boundaries are public.
    expect(["parseDecisionQueueInput", "projectOwnerDecisionQueue", "deriveNotificationDecision",
      "NotificationIntentStore", "DecisionNotificationService"].every(key => key in publicApi)).toBe(true);
  });
});
