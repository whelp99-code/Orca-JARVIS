import { describe, expect, it } from "vitest";
import { canonicalize, rankPriorityActions } from "../../src/index.js";
import {
  priorityLexicographicCandidates,
  type PriorityLexicographicField,
} from "../fixtures/priority-engine-candidates.js";
import {
  PRIORITY_POLICY_REF,
  priorityEngineInput,
  priorityPolicyConfig,
} from "../fixtures/priority-engine-input.js";

const LEXICOGRAPHIC_ORDER = [
  "owner_safety_gate",
  "customer_impact",
  "deadline_bucket",
  "dependency_blocking",
  "irreversible_risk",
  "effort_cost",
  "stable_identity",
] as const;

const FIELDS: readonly PriorityLexicographicField[] = LEXICOGRAPHIC_ORDER;

describe("Task 17 deterministic priority ranking", () => {
  it("ranks actionable customer work above self-development while preserving dispositions", () => {
    // Given: current customer, delegated worker, self-development, owner-gated, and unsafe work.
    const input = priorityEngineInput();
    // When: the public priority engine evaluates the eligible Linux evidence.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    // Then: actionable customer work leads and no disposition grants execution authority.
    expect(result.status).toBe("ranked");
    expect(result.authority).toBe("none");
    expect(result.effect).toBe("none");
    expect(result.actions.map(action => ({
      action_id: action.action_id,
      rank: action.rank,
      disposition: action.disposition,
    }))).toEqual([
      { action_id: "customer-delivery", rank: 1, disposition: "executable" },
      { action_id: "worker-implementation", rank: 2, disposition: "delegated" },
      { action_id: "jarvis-self-development", rank: 3, disposition: "executable" },
      { action_id: "owner-gated-deploy", rank: 4, disposition: "owner_gate_required" },
      { action_id: "unsafe-production-change", rank: null, disposition: "excluded" },
    ]);
    expect(result.actions.every(action => action.authority === "none")).toBe(true);
  });

  it("exposes the deciding fields and complete Linux citations without a score", () => {
    // Given: a customer-critical action whose deadline and dependency affect its rank.
    const input = priorityEngineInput();
    // When: ranking produces its machine-readable rationale.
    const result = rankPriorityActions(priorityPolicyConfig(), input);
    const customer = result.actions.find(action => action.action_id === "customer-delivery");
    if (customer === undefined) throw new TypeError("ranked customer action required");
    // Then: every selected source is explicit and no hidden-score surface exists.
    expect(result.lexicographic_order).toEqual(LEXICOGRAPHIC_ORDER);
    expect(customer.rationale.lexicographic_fields).toEqual({
      owner_safety_gate: "pass",
      customer_impact: "customer_critical",
      deadline_bucket: "today",
      dependency_blocking: "blocks_customer",
      irreversible_risk: "medium",
      effort_cost: "high",
      stable_identity: "customer-delivery",
    });
    expect(customer.rationale.citations).toMatchObject({
      confirmed_principle_ref: "memory:principle:customer-first",
      confirmed_principle_evidence_ref: "second-brain:sid:customer-first",
      linux_policy_decision_ref: PRIORITY_POLICY_REF,
      owner_import_decision_ref: "decision:owner:import",
      current_linux_evidence_ref: "live:customer",
      deadline_evidence_ref: "live:customer",
      dependency_evidence_ref: "live:customer",
    });
    for (const action of result.actions.filter(item => item.rank !== null)) {
      expect(action.rationale.citations.confirmed_principle_ref).toBe("memory:principle:customer-first");
      expect(action.rationale.citations.linux_policy_decision_ref).toBe(PRIORITY_POLICY_REF);
      expect(action.rationale.citations.current_linux_evidence_ref).not.toBeNull();
    }
    expect(Object.hasOwn(result, "score")).toBe(false);
    expect(Object.hasOwn(customer.rationale, "score")).toBe(false);
  });

  it.each(FIELDS)("uses %s in the documented lexicographic position", field => {
    // Given: two candidates equal on every earlier field and opposed on later fields.
    const candidates = priorityLexicographicCandidates(field);
    // When: the pair is ranked from reversed insertion order.
    const result = rankPriorityActions(priorityPolicyConfig(), priorityEngineInput({ candidates, reverse: true }));
    const ranked = result.actions.filter(action => action.rank !== null);
    const winner = ranked[0];
    // Then: the declared field alone decides the first rank.
    expect(winner?.action_id).toBe(field === "stable_identity" ? "action-z" : "action-a");
    expect(winner?.rationale.decisive_field).toBe(field);
  });

  it("returns byte-identical canonical output across insertion, model, and Mac presentation changes", () => {
    // Given: logically identical inputs with opposite insertion order and disagreeing presentation-only data.
    const first = priorityEngineInput();
    const second = priorityEngineInput({ reverse: true, presentationVariant: true });
    // When: both are ranked under one fixed clock.
    const firstOutput = canonicalize(rankPriorityActions(priorityPolicyConfig(), first));
    const secondOutput = canonicalize(rankPriorityActions(priorityPolicyConfig(), second));
    // Then: non-authoritative ordering, model, and Mac data cannot alter any output byte.
    expect(secondOutput).toBe(firstOutput);
  });
});
