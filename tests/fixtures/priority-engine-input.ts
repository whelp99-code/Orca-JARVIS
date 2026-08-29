import { contextPolicyConfig } from "./context-policy-input.js";
import { defaultPriorityCandidates, priorityCandidateFixture } from "./priority-engine-candidates.js";

export const PRIORITY_NOW = "2026-08-28T12:00:00.000Z";
export const PRIORITY_POLICY_REF = "policy:linux:personal-os-policy-v1:task17";

export type PriorityFailureFixture =
  | "context_abstain"
  | "import_approval_required"
  | "import_wrong_binding"
  | "inferred"
  | "mac_only"
  | "missing_citation"
  | "missing_policy_citation"
  | "no_data"
  | "offline"
  | "stale_deadline"
  | "stale_memory"
  | "tie"
  | "unavailable"
  | "unconfirmed"
  | "untrusted";

type FixtureOptions = {
  readonly candidates?: readonly Record<string, unknown>[];
  readonly failure?: PriorityFailureFixture;
  readonly presentationVariant?: boolean;
  readonly reverse?: boolean;
};
type FailureMaterial = {
  readonly evidence: Record<string, unknown>[];
  readonly principles: Record<string, unknown>[];
  readonly candidates: Record<string, unknown>[];
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const LIVE_REFS = ["live:customer", "live:worker", "live:self", "live:owner-gated", "live:safety"] as const;

function policyFact(
  ref: string,
  evidenceClass: "linux_live_fact" | "user_confirmed_principle" | "owner_decision",
): Record<string, unknown> {
  return {
    kind: "evidence",
    ref,
    evidence_class: evidenceClass,
    source_host: evidenceClass === "user_confirmed_principle" ? "linux-second-brain" : "linux-control-plane",
    state: "current",
    trust: "user_confirmed",
    relation: "supports",
    relates_to: evidenceClass === "linux_live_fact" ? null : "live:customer",
    observed_at: "2026-08-28T11:30:00.000Z",
    valid_from: "2026-08-28T11:00:00.000Z",
    valid_until: "2026-08-28T18:00:00.000Z",
    fresh_until: "2026-08-28T12:30:00.000Z",
  };
}

function principleEvidence(): Record<string, unknown> {
  return {
    kind: "evidence",
    principle_ref: "memory:principle:customer-first",
    evidence_ref: "second-brain:sid:customer-first",
    source_id: "src:pos:v1:second-brain:primary",
    source_host: "linux-second-brain",
    content_digest: DIGEST,
    trust: "user_confirmed",
    observed_at: "2026-08-28T11:30:00.000Z",
    fresh_until: "2026-08-28T12:30:00.000Z",
    import_gate: {
      gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL",
      state: "approved",
      decision_ref: "decision:owner:import",
      decision_host: "linux-control-plane",
    },
  };
}

function applyFailure(failure: PriorityFailureFixture, material: FailureMaterial): void {
  const { evidence, principles, candidates } = material;
  const principle = principles[0];
  const policyPrinciple = evidence.find(item => item["ref"] === "memory:principle:customer-first");
  if (principle === undefined || policyPrinciple === undefined) throw new TypeError("priority fixture principle required");
  switch (failure) {
    case "context_abstain": evidence.splice(evidence.findIndex(item => item["ref"] === "decision:owner:import"), 1); return;
    case "import_approval_required":
      principle["import_gate"] = {
        gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL",
        state: "required",
        decision_ref: null,
        decision_host: "linux-control-plane",
      };
      return;
    case "import_wrong_binding":
      principle["import_gate"] = {
        gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL",
        state: "approved",
        decision_ref: "live:customer",
        decision_host: "linux-control-plane",
      };
      return;
    case "inferred": principle["trust"] = "inferred"; policyPrinciple["trust"] = "inferred"; return;
    case "mac_only":
      principle["source_id"] = "src:pos:v1:mac-client:priority";
      principle["source_host"] = "mac-client";
      policyPrinciple["source_host"] = "mac-client";
      return;
    case "missing_citation": {
      const first = candidates[0];
      if (first === undefined) throw new TypeError("priority fixture candidate required");
      first["current_evidence_ref"] = null;
      return;
    }
    case "missing_policy_citation": return;
    case "no_data": case "offline": case "unavailable":
      principles.splice(0, 1, {
        kind: "gap",
        principle_ref: "memory:principle:customer-first",
        source_id: "src:pos:v1:second-brain:primary",
        source_host: "linux-second-brain",
        state: failure,
        checked_at: PRIORITY_NOW,
      });
      evidence.splice(evidence.indexOf(policyPrinciple), 1, {
        kind: "gap",
        ref: `memory:${failure}`,
        evidence_class: "user_confirmed_principle",
        source_host: "linux-second-brain",
        state: failure,
        checked_at: PRIORITY_NOW,
      });
      return;
    case "stale_deadline": {
      const first = candidates[0];
      if (first === undefined) throw new TypeError("priority fixture candidate required");
      first["deadline"] = {
        due_at: "2026-08-28T17:00:00.000Z",
        evidence_ref: "live:self",
        observed_at: "2026-08-28T11:00:00.000Z",
        fresh_until: "2026-08-28T11:59:59.999Z",
      };
      return;
    }
    case "stale_memory":
      principle["fresh_until"] = "2026-08-28T11:59:59.999Z";
      policyPrinciple["state"] = "stale";
      return;
    case "tie": {
      const left = priorityCandidateFixture("tie-a", "live:customer");
      const right = priorityCandidateFixture("tie-b", "live:customer");
      left["stable_identity"] = null;
      right["stable_identity"] = null;
      candidates.splice(0, candidates.length, left, right);
      return;
    }
    case "unconfirmed": principle["trust"] = "unconfirmed"; return;
    case "untrusted": principle["trust"] = "untrusted"; policyPrinciple["trust"] = "untrusted"; return;
    default: { const exhaustive: never = failure; return exhaustive; }
  }
}

export function priorityPolicyConfig(): unknown {
  return contextPolicyConfig();
}

export function priorityEngineInput(options: FixtureOptions = {}): Readonly<Record<string, unknown>> {
  const evidence = [
    ...LIVE_REFS.map(ref => policyFact(ref, "linux_live_fact")),
    policyFact("memory:principle:customer-first", "user_confirmed_principle"),
    policyFact("decision:owner:import", "owner_decision"),
  ];
  if (options.presentationVariant === true) {
    const macEvidence = policyFact("mac:priority:presentation", "linux_live_fact");
    macEvidence["source_host"] = "mac-client";
    evidence.push(macEvidence);
  }
  const principles = [principleEvidence()];
  if (options.presentationVariant === true) {
    const macPrinciple = principleEvidence();
    macPrinciple["principle_ref"] = "mac:principle:presentation";
    macPrinciple["source_id"] = "src:pos:v1:mac-client:presentation";
    macPrinciple["source_host"] = "mac-client";
    principles.push(macPrinciple);
  }
  const candidates = (options.candidates ?? defaultPriorityCandidates()).map(item => structuredClone(item));
  if (options.failure !== undefined) applyFailure(options.failure, { evidence, principles, candidates });
  const reverse = options.reverse === true;
  return {
    schema_version: 1,
    clock: PRIORITY_NOW,
    linux_policy_decision_ref: options.failure === "missing_policy_citation" ? null : PRIORITY_POLICY_REF,
    context_policy_input: {
      schema_version: 1,
      clock: PRIORITY_NOW,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: reverse ? [...evidence].reverse() : evidence,
    },
    principles: reverse ? [...principles].reverse() : principles,
    candidates: reverse ? [...candidates].reverse() : candidates,
    presentation: options.presentationVariant === true
      ? {
          model_disagrees: true,
          model_preferred_action_ids: ["owner-gated-deploy", "jarvis-self-development"],
          mac_evidence_refs: ["mac:file:priority", "mac:env:override"],
        }
      : { model_disagrees: false, model_preferred_action_ids: [], mac_evidence_refs: [] },
  };
}
