import { describe, expect, it } from "vitest";
import { evaluateContextPolicy } from "../../src/index.js";
import { contextPolicyConfig, contextPolicyFact, contextPolicyInput } from "../fixtures/context-policy-input.js";

describe("Task 16 eligible and relation decisions", () => {
  it("is eligible with current Linux live, confirmed principle, and owner decision evidence", () => {
    // Given: all configured required evidence from Linux-owned sources.
    const input = contextPolicyInput();
    // When: deterministic context policy evaluates the evidence.
    const decision = evaluateContextPolicy(contextPolicyConfig(), input);
    // Then: all required references are selected under the supplied policy.
    expect(decision).toEqual({
      status: "eligible",
      policy_id: "personal-os-policy-v1",
      reason_codes: ["POLICY_SATISFIED"],
      selected_refs: ["decision:owner:1", "live:task:1", "memory:principle:1"],
      excluded_refs: [], conflicting_refs: [], superseded_refs: [],
      required_evidence_refs: ["decision:owner:1", "live:task:1", "memory:principle:1"],
    });
  });

  it("excludes unrelated evidence without making optional evidence authoritative", () => {
    // Given: sufficient required evidence plus an unrelated optional principle.
    const base = contextPolicyInput();
    const unrelated = contextPolicyFact("memory:unrelated", "user_confirmed_principle");
    unrelated["relation"] = "unrelated";
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    // When: the unrelated relation is evaluated.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, unrelated] });
    // Then: it is explicitly excluded and cannot change eligibility.
    expect(decision.status).toBe("eligible");
    expect(decision.excluded_refs).toContain("memory:unrelated");
    expect(decision.reason_codes).toEqual(["POLICY_SATISFIED"]);
  });

  it("abstains when two confirmed priorities remain unresolved", () => {
    // Given: two current confirmed principles without explicit supersession.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    const second = contextPolicyFact("memory:principle:2", "user_confirmed_principle");
    // When: both priorities are evaluated without valid-time resolution.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, second] });
    // Then: no insertion order or newest-wins fallback selects a priority.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain("UNRESOLVED_PRIORITY_CONFLICT");
    expect(decision.conflicting_refs).toEqual(["memory:principle:1", "memory:principle:2"]);
  });

  it("abstains with both references when a fact contradicts selected evidence", () => {
    // Given: a confirmed contradiction targeting the current live fact.
    const base = contextPolicyInput();
    const contradiction = contextPolicyFact("memory:contradiction", "user_confirmed_principle");
    contradiction["relation"] = "contradicts";
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    // When: the contradictory relation is evaluated.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, contradiction] });
    // Then: policy abstains and preserves both conflict references.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain("UNRESOLVED_CONFLICT");
    expect(decision.conflicting_refs).toEqual(["live:task:1", "memory:contradiction"]);
  });
});
