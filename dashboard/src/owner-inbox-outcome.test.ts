import { describe, expect, it } from "vitest";
import { inboxExecutionOutcome } from "./owner-inbox-outcome.js";

describe("inbox execution outcome", () => {
  it("keeps state and failure code, not a payload", () => {
    expect(inboxExecutionOutcome("approve", { state: "completed" })).toEqual({ state: "completed" });
    expect(inboxExecutionOutcome("approve", { state: "failed", failure_code: "RUNBOOK_FAILED" })).toEqual({
      state: "failed", failure_code: "RUNBOOK_FAILED",
    });
    expect(inboxExecutionOutcome("approve", { state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING" })).toEqual({
      state: "uncertain", failure_code: "MEMORY_OUTBOX_RECONCILING",
    });
    expect(inboxExecutionOutcome("approve", { state: "approved", manual_wait: true })).toEqual({ state: "approved" });
    expect(inboxExecutionOutcome("approve", { primary: { state: "failed", failure_code: "X" } })).toEqual({ state: "failed", failure_code: "X" });
    expect(inboxExecutionOutcome("reject", undefined)).toEqual({ state: "rejected" });
  });
});
