import { describe, expect, it } from "vitest";
import { rankPriorityActions, type PriorityReasonCode } from "../../src/index.js";
import {
  priorityEngineInput,
  priorityPolicyConfig,
  type PriorityFailureFixture,
} from "../fixtures/priority-engine-input.js";

const FAILURES: readonly (readonly [PriorityFailureFixture, PriorityReasonCode])[] = [
  ["no_data", "PRIORITY_MEMORY_NO_DATA"],
  ["stale_memory", "PRIORITY_MEMORY_STALE"],
  ["offline", "PRIORITY_MEMORY_OFFLINE"],
  ["unavailable", "PRIORITY_MEMORY_UNAVAILABLE"],
  ["inferred", "PRIORITY_PRINCIPLE_INFERRED"],
  ["untrusted", "PRIORITY_PRINCIPLE_UNTRUSTED"],
  ["mac_only", "PRIORITY_PRINCIPLE_NON_LINUX"],
  ["unconfirmed", "PRIORITY_PRINCIPLE_UNCONFIRMED"],
  ["context_abstain", "PRIORITY_CONTEXT_POLICY_ABSTAINED"],
  ["import_approval_required", "PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED"],
  ["import_wrong_binding", "PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED"],
  ["missing_citation", "PRIORITY_REQUIRED_CITATION_MISSING"],
  ["missing_policy_citation", "PRIORITY_REQUIRED_CITATION_MISSING"],
  ["stale_deadline", "PRIORITY_STALE_DEADLINE"],
  ["tie", "PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE"],
];

describe("Task 17 explicit abstention and exclusion", () => {
  it.each(FAILURES)("emits a stable code for %s", (failure, code) => {
    // Given: one frozen failure class at the untrusted public boundary.
    const input = priorityEngineInput({ failure });
    // When: deterministic prioritization evaluates it.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: the failure is explicit globally and on an abstained action.
    expect(result.reason_codes).toContain(code);
    expect(result.actions.some(action => action.disposition === "abstained" && action.reason_codes.includes(code))).toBe(true);
  });

  it("never represents owner-gated work as executable", () => {
    // Given: an otherwise eligible action with a pending exact owner gate.
    const input = priorityEngineInput();
    // When: actions are classified and ranked.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    const gated = result.actions.find(action => action.action_id === "owner-gated-deploy");
    // Then: approval remains required and authority remains absent.
    expect(gated).toMatchObject({
      disposition: "owner_gate_required",
      authority: "none",
      reason_codes: ["PRIORITY_OWNER_APPROVAL_REQUIRED"],
    });
    expect(result.actions.some(action => action.action_id === "owner-gated-deploy" && action.disposition === "executable")).toBe(false);
  });

  it("rejects a non-closed input with a stable typed boundary error", () => {
    // Given: an otherwise valid input with an undeclared authority-shaped field.
    const input = { ...priorityEngineInput(), execute: true };
    // When: the public boundary parses it.
    const action = (): unknown => rankPriorityActions(priorityPolicyConfig(), input);
    // Then: it rejects rather than interpreting or executing the extra field.
    expect(action).toThrowError(expect.objectContaining({
      name: "PriorityEngineError",
      code: "PRIORITY_ENGINE_INPUT_INVALID",
    }));
  });

  it("rejects nested accessors without executing source-controlled getters", () => {
    // Given: an otherwise valid candidate containing an enumerable getter.
    const input = priorityEngineInput();
    const candidates = input["candidates"];
    if (!Array.isArray(candidates) || typeof candidates[0] !== "object" || candidates[0] === null) {
      throw new TypeError("priority candidate fixture required");
    }
    let reads = 0;
    Object.defineProperty(candidates[0], "customer_impact", {
      enumerable: true,
      get: () => { reads++; return "customer_critical"; },
    });
    // When: descriptors are inspected at the public boundary.
    const action = (): unknown => rankPriorityActions(priorityPolicyConfig(), input);
    // Then: no getter runs and the typed input error is preserved.
    expect(action).toThrowError(expect.objectContaining({ code: "PRIORITY_ENGINE_INPUT_INVALID" }));
    expect(reads).toBe(0);
  });
});
