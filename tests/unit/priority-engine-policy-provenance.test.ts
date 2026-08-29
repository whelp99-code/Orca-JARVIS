import { describe, expect, it } from "vitest";
import { rankPriorityActions } from "../../src/index.js";
import {
  PRIORITY_POLICY_REF,
  priorityEngineInput,
  priorityPolicyConfig,
} from "../fixtures/priority-engine-input.js";

const INVALID_POLICY_REFS = [
  "policy:linux:fake",
  "policy:linux:mismatched-policy-v9:task17",
  "policy:linux:personal-os-policy-v1:",
  "policy:linux:personal-os-policy-v1:bad selector",
  `policy:linux:personal-os-policy-v1:${"a".repeat(129)}`,
] as const;

describe("Task 17 remediation policy citation provenance", () => {
  it("preserves the exact evaluated Linux policy citation", () => {
    // Given: the valid Linux citation names the evaluated policy and a bounded selector.
    const input = priorityEngineInput();
    // When: actions are ranked.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: the trusted policy ref is retained globally and on every ranked action.
    expect(result.status).toBe("ranked");
    expect(result.linux_policy_decision_ref).toBe(PRIORITY_POLICY_REF);
    expect(result.actions.filter(action => action.rank !== null)
      .every(action => action.rationale.citations.linux_policy_decision_ref === PRIORITY_POLICY_REF)).toBe(true);
  });

  it.each(INVALID_POLICY_REFS)("abstains and redacts an unbound policy citation %s", policyRef => {
    // Given: a prefix-shaped, mismatched, empty, malformed, or overlong policy selector.
    const input = { ...priorityEngineInput(), linux_policy_decision_ref: policyRef };
    // When: policy citation provenance is evaluated.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: no action ranks and the untrusted reference is absent from trusted citations.
    expect(result.status).toBe("abstained");
    expect(result.reason_codes).toContain("PRIORITY_REQUIRED_CITATION_MISSING");
    expect(result.linux_policy_decision_ref).toBeNull();
    expect(result.actions.every(action => action.rank === null && action.disposition === "abstained")).toBe(true);
    expect(result.actions.every(action => action.rationale.citations.linux_policy_decision_ref === null)).toBe(true);
  });
});
