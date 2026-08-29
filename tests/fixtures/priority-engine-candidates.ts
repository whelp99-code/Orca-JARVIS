export type PriorityLexicographicField =
  | "owner_safety_gate"
  | "customer_impact"
  | "deadline_bucket"
  | "dependency_blocking"
  | "irreversible_risk"
  | "effort_cost"
  | "stable_identity";

function identity(key: string): Record<string, unknown> {
  return { key, evidence_ref: `identity:${key}` };
}

export function priorityCandidateFixture(actionId: string, currentEvidenceRef: string): Record<string, unknown> {
  return {
    action_id: actionId,
    execution_mode: "jarvis",
    owner_safety_gate: "pass",
    owner_gate_ref: null,
    customer_impact: "internal",
    deadline: null,
    dependency: { kind: "non_blocking" },
    irreversible_risk: "low",
    effort_cost: "medium",
    principle_ref: "memory:principle:customer-first",
    current_evidence_ref: currentEvidenceRef,
    stable_identity: identity(actionId),
  };
}

export function defaultPriorityCandidates(): Record<string, unknown>[] {
  const customer = priorityCandidateFixture("customer-delivery", "live:customer");
  customer["customer_impact"] = "customer_critical";
  customer["deadline"] = {
    due_at: "2026-08-28T17:00:00.000Z",
    evidence_ref: "live:customer",
    observed_at: "2026-08-28T11:30:00.000Z",
    fresh_until: "2026-08-28T12:30:00.000Z",
  };
  customer["dependency"] = { kind: "blocks_customer", evidence_ref: "live:customer" };
  customer["irreversible_risk"] = "medium";
  customer["effort_cost"] = "high";

  const worker = priorityCandidateFixture("worker-implementation", "live:worker");
  worker["execution_mode"] = "delegated";
  worker["effort_cost"] = "low";

  const self = priorityCandidateFixture("jarvis-self-development", "live:self");
  const owner = priorityCandidateFixture("owner-gated-deploy", "live:owner-gated");
  owner["owner_safety_gate"] = "owner_approval_required";
  owner["owner_gate_ref"] = "request:owner:deploy";
  owner["customer_impact"] = "customer_critical";

  const blocked = priorityCandidateFixture("unsafe-production-change", "live:safety");
  blocked["owner_safety_gate"] = "safety_blocked";
  blocked["customer_impact"] = "customer_critical";
  return [self, blocked, owner, customer, worker];
}

function deadline(dueAt: string): Record<string, unknown> {
  return {
    due_at: dueAt,
    evidence_ref: "live:customer",
    observed_at: "2026-08-28T11:30:00.000Z",
    fresh_until: "2026-08-28T12:30:00.000Z",
  };
}

export function priorityLexicographicCandidates(field: PriorityLexicographicField): readonly Record<string, unknown>[] {
  const first = priorityCandidateFixture(field === "stable_identity" ? "action-z" : "action-a", "live:customer");
  const second = priorityCandidateFixture(field === "stable_identity" ? "action-a" : "action-b", "live:customer");
  first["stable_identity"] = identity(field === "stable_identity" ? "identity-a" : "identity-z");
  second["stable_identity"] = identity(field === "stable_identity" ? "identity-b" : "identity-a");
  switch (field) {
    case "owner_safety_gate":
      first["effort_cost"] = "high";
      second["owner_safety_gate"] = "owner_approval_required";
      second["owner_gate_ref"] = "request:owner:later";
      second["customer_impact"] = "customer_critical";
      second["effort_cost"] = "low";
      break;
    case "customer_impact":
      first["customer_impact"] = "customer_critical";
      first["irreversible_risk"] = "high";
      first["effort_cost"] = "high";
      second["customer_impact"] = "customer_high";
      second["effort_cost"] = "low";
      break;
    case "deadline_bucket":
      first["deadline"] = deadline("2026-08-28T17:00:00.000Z");
      first["effort_cost"] = "high";
      second["deadline"] = deadline("2026-09-30T17:00:00.000Z");
      second["effort_cost"] = "low";
      break;
    case "dependency_blocking":
      first["dependency"] = { kind: "blocks_customer", evidence_ref: "live:customer" };
      first["effort_cost"] = "high";
      second["effort_cost"] = "low";
      break;
    case "irreversible_risk":
      first["irreversible_risk"] = "low";
      first["effort_cost"] = "high";
      second["irreversible_risk"] = "medium";
      second["effort_cost"] = "low";
      break;
    case "effort_cost":
      first["effort_cost"] = "low";
      second["effort_cost"] = "high";
      break;
    case "stable_identity":
      first["stable_identity"] = { key: "identity-a", evidence_ref: "live:customer" };
      second["stable_identity"] = { key: "identity-b", evidence_ref: "live:worker" };
      break;
    default: { const exhaustive: never = field; return exhaustive; }
  }
  return [second, first];
}
