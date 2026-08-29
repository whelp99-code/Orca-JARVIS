import { describe, expect, it } from "vitest";
import { CONTEXT_POLICY_CONFIG_INVALID, CONTEXT_POLICY_INPUT_INVALID, ContextPolicyError, evaluateContextPolicy } from "../../src/index.js";
import { contextPolicyConfig, contextPolicyFact, contextPolicyInput } from "../fixtures/context-policy-input.js";

describe("Task 16 supersession, skew, and public boundary", () => {
  it("accepts explicit trusted non-overlapping valid-time supersession", () => {
    // Given: a confirmed replacement starts when the prior principle ceases to be valid.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence) || typeof evidence[1] !== "object" || evidence[1] === null) throw new TypeError("memory fixture required");
    evidence[1].valid_until = "2026-08-28T11:15:00.000Z";
    const replacement = contextPolicyFact("memory:principle:2", "user_confirmed_principle");
    replacement["relation"] = "supersedes"; replacement["relates_to"] = "memory:principle:1";
    replacement["valid_from"] = "2026-08-28T11:15:00.000Z";
    // When: supersession is evaluated from explicit valid times.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, replacement] });
    // Then: only the replacement remains selected and the prior ref is manifest.
    expect(decision.status).toBe("eligible");
    expect(decision.selected_refs).toContain("memory:principle:2");
    expect(decision.selected_refs).not.toContain("memory:principle:1");
    expect(decision.superseded_refs).toEqual(["memory:principle:1"]);
  });

  it("abstains instead of choosing newest when valid-time semantics overlap", () => {
    // Given: a claimed supersession overlaps its target's valid interval.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    const replacement = contextPolicyFact("memory:principle:2", "user_confirmed_principle");
    replacement["relation"] = "supersedes"; replacement["relates_to"] = "memory:principle:1";
    // When: explicit valid-time ordering conflicts.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, replacement] });
    // Then: both refs remain conflicting and policy abstains.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain("SUPERSESSION_VALID_TIME_CONFLICT");
    expect(decision.conflicting_refs).toEqual(expect.arrayContaining(["memory:principle:1", "memory:principle:2"]));
  });

  it("abstains when supersession trust is inadequate or priorities remain unresolved", () => {
    // Given: two principles where an inferred one claims supersession.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    const replacement = contextPolicyFact("memory:principle:2", "user_confirmed_principle");
    replacement["relation"] = "supersedes"; replacement["relates_to"] = "memory:principle:1"; replacement["trust"] = "inferred";
    // When: policy evaluates the unresolved priorities.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, replacement] });
    // Then: trust cannot establish supersession and no newest-wins fallback occurs.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toEqual(expect.arrayContaining(["INFERRED_EVIDENCE", "UNRESOLVED_PRIORITY_CONFLICT"]));
  });

  it("abstains on future source time without reading dates before parsing", () => {
    // Given: a source observation after the supplied policy clock.
    const input = structuredClone(contextPolicyInput());
    const evidence = input["evidence"];
    if (!Array.isArray(evidence) || typeof evidence[0] !== "object" || evidence[0] === null) throw new TypeError("live fixture required");
    evidence[0].observed_at = "2026-08-28T12:00:00.001Z";
    // When: source skew is evaluated.
    const decision = evaluateContextPolicy(contextPolicyConfig(), input);
    // Then: the source is excluded with a stable skew code.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain("SOURCE_CLOCK_SKEW");
    expect(decision.excluded_refs).toContain("live:task:1");
  });

  it("rejects malformed and accessor-bearing public values with typed errors and zero getter reads", () => {
    // Given: accessor-bearing input and config records.
    const input = contextPolicyInput(); const policy = contextPolicyConfig(); let reads = 0;
    Object.defineProperty(input, "clock", { enumerable: true, get: () => { reads++; return "2026-08-28T12:00:00.000Z"; } });
    Object.defineProperty(policy, "policy_id", { enumerable: true, get: () => { reads++; return "personal-os-policy-v1"; } });
    // When: each unknown boundary is inspected by descriptor.
    const inputAction = (): unknown => evaluateContextPolicy(contextPolicyConfig(), input);
    const policyAction = (): unknown => evaluateContextPolicy(policy, contextPolicyInput());
    // Then: neither getter runs and each boundary has its Task 16 code.
    expect(inputAction).toThrowError(expect.objectContaining({ name: "ContextPolicyError", code: CONTEXT_POLICY_INPUT_INVALID }));
    expect(policyAction).toThrowError(expect.objectContaining({ name: "ContextPolicyError", code: CONTEXT_POLICY_CONFIG_INVALID }));
    expect(reads).toBe(0);
    expect(ContextPolicyError).toBeDefined();
  });
});
