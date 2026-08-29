import { describe, expect, it } from "vitest";
import { CONTEXT_POLICY_CONFIG_INVALID, CONTEXT_POLICY_INPUT_INVALID, ContextPolicyError, evaluateContextPolicy } from "../../src/index.js";
import { contextPolicyConfig, contextPolicyFact, contextPolicyInput } from "../fixtures/context-policy-input.js";

const invalidTargetCases = [
  ["explicit stale state", "STALE_EVIDENCE", (target: Record<string, unknown>, replacement: Record<string, unknown>) => {
    target["state"] = "stale"; target["valid_until"] = "2026-08-28T11:15:00.000Z";
    replacement["valid_from"] = "2026-08-28T11:15:00.000Z";
  }],
  ["expired freshness", "STALE_EVIDENCE", (target: Record<string, unknown>, replacement: Record<string, unknown>) => {
    target["fresh_until"] = "2026-08-28T11:45:00.000Z"; target["valid_until"] = "2026-08-28T11:50:00.000Z";
    replacement["valid_from"] = "2026-08-28T11:50:00.000Z";
  }],
  ["future observation", "SOURCE_CLOCK_SKEW", (target: Record<string, unknown>, replacement: Record<string, unknown>) => {
    target["observed_at"] = "2026-08-28T12:00:00.001Z"; target["valid_until"] = "2026-08-28T11:15:00.000Z";
    replacement["valid_from"] = "2026-08-28T11:15:00.000Z";
  }],
  ["future valid-from", "SOURCE_CLOCK_SKEW", (target: Record<string, unknown>, replacement: Record<string, unknown>) => {
    target["valid_from"] = "2026-08-28T12:00:00.001Z"; target["valid_until"] = "2026-08-28T12:00:00.002Z";
    replacement["valid_from"] = "2026-08-28T12:00:00.002Z";
  }],
] as const;

describe("Task 16 supersession, skew, and public boundary", () => {
  it.each(invalidTargetCases)("does not revive a supersession target with %s", (_name, code, mutate) => {
    // Given: a candidate points at a target that cannot establish current source validity.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence) || typeof evidence[1] !== "object" || evidence[1] === null) throw new TypeError("memory fixture required");
    const target = evidence[1];
    const replacement = contextPolicyFact("memory:principle:2", "user_confirmed_principle");
    replacement["relation"] = "supersedes"; replacement["relates_to"] = "memory:principle:1"; mutate(target, replacement);
    // When: deterministic supersession policy evaluates both facts.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [...evidence, replacement] });
    // Then: the invalid target is excluded and cannot satisfy or be superseded into eligibility.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain(code);
    expect(decision.excluded_refs).toContain("memory:principle:1");
    expect(decision.selected_refs).not.toContain("memory:principle:1");
    expect(decision.superseded_refs).not.toContain("memory:principle:1");
  });

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

  it("treats exact policy expiry as expired while retaining the effective boundary", () => {
    // Given: the supplied policy expires exactly at the evaluation clock.
    const policy = contextPolicyConfig();
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) throw new TypeError("policy fixture required");
    Reflect.set(policy, "expires_at", "2026-08-28T12:00:00.000Z");
    // When: policy time boundaries are evaluated.
    const decision = evaluateContextPolicy(policy, contextPolicyInput());
    // Then: expiry is exclusive and yields the stable fail-closed code.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toEqual(["POLICY_EXPIRED"]);
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
