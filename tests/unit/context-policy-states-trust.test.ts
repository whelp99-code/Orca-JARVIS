import { describe, expect, it } from "vitest";
import { evaluateContextPolicy } from "../../src/index.js";
import { contextPolicyConfig, contextPolicyFact, contextPolicyInput, POLICY_CLOCK } from "../fixtures/context-policy-input.js";

const failed = (state: "no_data" | "offline" | "unavailable", ref: string) => ({
  kind: "gap", ref, evidence_class: "user_confirmed_principle", source_host: "linux-second-brain", state, checked_at: POLICY_CLOCK,
});

describe("Task 16 state, trust, and required evidence abstention", () => {
  it.each([
    ["no_data", "NO_DATA"], ["offline", "SOURCE_OFFLINE"], ["unavailable", "SOURCE_UNAVAILABLE"],
  ] as const)("abstains for %s with a stable source-state code", (state, code) => {
    // Given: a required principle source reports a typed non-current state.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    // When: the failed source replaces the principle evidence.
    const decision = evaluateContextPolicy(contextPolicyConfig(), {
      ...base,
      evidence: [...evidence.slice(0, 1), ...evidence.slice(2), failed(state, `memory:${state}`)],
    });
    // Then: the exact source state and reference are preserved.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain(code);
    expect(decision.excluded_refs).toContain(`memory:${state}`);
  });

  it("abstains for stale-only status evidence", () => {
    // Given: the only live fact is explicitly stale.
    const input = structuredClone(contextPolicyInput());
    const evidence = input["evidence"];
    if (!Array.isArray(evidence) || typeof evidence[0] !== "object" || evidence[0] === null) throw new TypeError("live fixture required");
    evidence[0].state = "stale";
    // When: current truth is evaluated.
    const decision = evaluateContextPolicy(contextPolicyConfig(), input);
    // Then: stale evidence is excluded and policy abstains.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain("STALE_EVIDENCE");
    expect(decision.excluded_refs).toContain("live:task:1");
  });

  it.each(["inferred", "untrusted"] as const)("abstains for %s required memory", trust => {
    // Given: a poisoned or merely inferred required principle.
    const input = structuredClone(contextPolicyInput());
    const evidence = input["evidence"];
    if (!Array.isArray(evidence) || typeof evidence[1] !== "object" || evidence[1] === null) throw new TypeError("memory fixture required");
    evidence[1].trust = trust;
    // When: trust policy evaluates the memory.
    const decision = evaluateContextPolicy(contextPolicyConfig(), input);
    // Then: it is excluded under a stable trust-specific reason.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toContain(trust === "inferred" ? "INFERRED_EVIDENCE" : "UNTRUSTED_EVIDENCE");
    expect(decision.excluded_refs).toContain("memory:principle:1");
  });

  it("abstains with an explicit Linux-live requirement when current Linux evidence is absent", () => {
    // Given: confirmed memory and owner decision without a Linux live fact.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    // When: policy evaluates the required evidence set.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: evidence.slice(1) });
    // Then: the Linux requirement and missing reference remain explicit.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toEqual(expect.arrayContaining(["LINUX_LIVE_EVIDENCE_REQUIRED", "REQUIRED_EVIDENCE_MISSING"]));
    expect(decision.required_evidence_refs).toContain("required:linux_live_fact");
  });

  it("abstains when owner decision or another required evidence class is absent", () => {
    // Given: no owner-decision evidence and an explicitly required class.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    // When: policy evaluates the incomplete set.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: evidence.slice(0, 2) });
    // Then: owner authority stays absent and the missing requirement is referenced.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toEqual(expect.arrayContaining(["OWNER_DECISION_REQUIRED", "REQUIRED_EVIDENCE_MISSING"]));
    expect(decision.required_evidence_refs).toContain("required:owner_decision");
  });

  it("does not let Mac evidence satisfy or override a Linux abstention", () => {
    // Given: a Mac-hosted principle replaces required Linux memory.
    const base = contextPolicyInput();
    const evidence = structuredClone(base["evidence"]);
    if (!Array.isArray(evidence)) throw new TypeError("policy evidence fixture required");
    const mac = contextPolicyFact("memory:mac", "user_confirmed_principle", "mac-client");
    // When: policy evaluates client evidence.
    const decision = evaluateContextPolicy(contextPolicyConfig(), { ...base, evidence: [evidence[0], evidence[2], mac] });
    // Then: Mac remains excluded and required Linux evidence remains missing.
    expect(decision.status).toBe("abstain");
    expect(decision.reason_codes).toEqual(expect.arrayContaining(["MAC_NON_AUTHORITATIVE", "REQUIRED_EVIDENCE_MISSING"]));
    expect(decision.excluded_refs).toContain("memory:mac");
  });
});
