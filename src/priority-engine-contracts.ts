import type { ContextPolicyReasonCode } from "./context-policy.js";
import type { ParsedContextPolicyInput } from "./context-policy-input.js";

export const PRIORITY_LEXICOGRAPHIC_POLICY = {
  fields: [
    "owner_safety_gate",
    "customer_impact",
    "deadline_bucket",
    "dependency_blocking",
    "irreversible_risk",
    "effort_cost",
    "stable_identity",
  ],
  owner_safety_gate: ["pass", "owner_approval_required", "safety_blocked"],
  customer_impact: ["customer_critical", "customer_high", "customer_standard", "internal"],
  deadline_bucket: ["overdue", "today", "within_seven_days", "later", "none"],
  dependency_blocking: ["blocks_customer", "blocks_work", "non_blocking"],
  irreversible_risk: ["low", "medium", "high"],
  effort_cost: ["low", "medium", "high"],
  stable_identity: "ascending",
} as const;

export const PRIORITY_LEXICOGRAPHIC_ORDER = PRIORITY_LEXICOGRAPHIC_POLICY.fields;
export const PRIORITY_REASON_CODES = [
  "PRIORITY_RANKED",
  "PRIORITY_EXECUTABLE",
  "PRIORITY_DELEGATED",
  "PRIORITY_OWNER_APPROVAL_REQUIRED",
  "PRIORITY_SAFETY_BLOCKED",
  "PRIORITY_CONTEXT_POLICY_ABSTAINED",
  "PRIORITY_MEMORY_NO_DATA",
  "PRIORITY_MEMORY_STALE",
  "PRIORITY_MEMORY_OFFLINE",
  "PRIORITY_MEMORY_UNAVAILABLE",
  "PRIORITY_PRINCIPLE_INFERRED",
  "PRIORITY_PRINCIPLE_UNTRUSTED",
  "PRIORITY_PRINCIPLE_UNCONFIRMED",
  "PRIORITY_PRINCIPLE_NON_LINUX",
  "PRIORITY_PRINCIPLE_NOT_POLICY_SELECTED",
  "PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED",
  "PRIORITY_REQUIRED_CITATION_MISSING",
  "PRIORITY_STALE_DEADLINE",
  "PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE",
] as const;

export type PriorityReasonCode = (typeof PRIORITY_REASON_CODES)[number];
export type PriorityLexicographicField = (typeof PRIORITY_LEXICOGRAPHIC_ORDER)[number];
export type PriorityOwnerSafetyGate = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate)[number];
export type PriorityCustomerImpact = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact)[number];
export type PriorityDeadlineBucket = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket)[number];
export type PriorityDependencyBlocking = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking)[number];
export type PriorityIrreversibleRisk = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk)[number];
export type PriorityEffortCost = (typeof PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost)[number];

export type PriorityImportGate = {
  readonly gate_id: string;
  readonly state: "approved" | "required";
  readonly decision_ref: string | null;
  readonly decision_host: "linux-control-plane" | "mac-client" | "phone-client";
};
export type PriorityPrincipleEvidence = {
  readonly kind: "evidence";
  readonly principle_ref: string;
  readonly evidence_ref: string | null;
  readonly source_id: string;
  readonly source_host: "linux-second-brain" | "mac-client" | "phone-client";
  readonly content_digest: string | null;
  readonly trust: "user_confirmed" | "inferred" | "untrusted" | "unconfirmed";
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly import_gate: PriorityImportGate;
};
export type PriorityPrincipleGap = {
  readonly kind: "gap";
  readonly principle_ref: string;
  readonly source_id: string;
  readonly source_host: "linux-second-brain" | "mac-client" | "phone-client";
  readonly state: "no_data" | "stale" | "offline" | "unavailable";
  readonly checked_at: string;
};
export type PriorityPrincipleSource = PriorityPrincipleEvidence | PriorityPrincipleGap;
export type PriorityDeadline = {
  readonly due_at: string;
  readonly evidence_ref: string | null;
  readonly observed_at: string;
  readonly fresh_until: string;
};
export type PriorityDependency =
  | { readonly kind: "non_blocking" }
  | { readonly kind: "blocks_customer" | "blocks_work"; readonly evidence_ref: string | null };
export type PriorityStableIdentity = { readonly key: string; readonly evidence_ref: string | null };
export type PriorityCandidateAction = {
  readonly action_id: string;
  readonly execution_mode: "jarvis" | "delegated";
  readonly owner_safety_gate: PriorityOwnerSafetyGate;
  readonly owner_gate_ref: string | null;
  readonly customer_impact: PriorityCustomerImpact;
  readonly deadline: PriorityDeadline | null;
  readonly dependency: PriorityDependency;
  readonly irreversible_risk: PriorityIrreversibleRisk;
  readonly effort_cost: PriorityEffortCost;
  readonly principle_ref: string | null;
  readonly current_evidence_ref: string | null;
  readonly stable_identity: PriorityStableIdentity | null;
};
export type ParsedPriorityEngineInput = {
  readonly clock: string;
  readonly linux_policy_decision_ref: string | null;
  readonly context_policy_input: ParsedContextPolicyInput;
  readonly principles: readonly PriorityPrincipleSource[];
  readonly candidates: readonly PriorityCandidateAction[];
};

export type PriorityLexicographicFields = {
  readonly owner_safety_gate: PriorityOwnerSafetyGate;
  readonly customer_impact: PriorityCustomerImpact;
  readonly deadline_bucket: PriorityDeadlineBucket;
  readonly dependency_blocking: PriorityDependencyBlocking;
  readonly irreversible_risk: PriorityIrreversibleRisk;
  readonly effort_cost: PriorityEffortCost;
  readonly stable_identity: string | null;
};
export type PriorityCitations = {
  readonly confirmed_principle_ref: string | null;
  readonly confirmed_principle_evidence_ref: string | null;
  readonly linux_policy_decision_ref: string | null;
  readonly owner_import_decision_ref: string | null;
  readonly current_linux_evidence_ref: string | null;
  readonly deadline_evidence_ref: string | null;
  readonly dependency_evidence_ref: string | null;
  readonly owner_gate_ref: string | null;
  readonly stable_identity_evidence_ref: string | null;
};
export type PriorityRationale = {
  readonly decisive_field: PriorityLexicographicField | "only_action" | null;
  readonly lexicographic_fields: PriorityLexicographicFields;
  readonly citations: PriorityCitations;
};
export type PriorityActionDisposition = "executable" | "delegated" | "owner_gate_required" | "excluded" | "abstained";
export type PriorityActionDecision = {
  readonly action_id: string;
  readonly rank: number | null;
  readonly disposition: PriorityActionDisposition;
  readonly authority: "none";
  readonly reason_codes: readonly PriorityReasonCode[];
  readonly rationale: PriorityRationale;
};
export type PriorityEngineResultV1 = {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly status: "ranked" | "abstained";
  readonly authority: "none";
  readonly effect: "none";
  readonly policy_id: string;
  readonly linux_policy_decision_ref: string | null;
  readonly context_policy_reason_codes: readonly ContextPolicyReasonCode[];
  readonly lexicographic_order: typeof PRIORITY_LEXICOGRAPHIC_ORDER;
  readonly reason_codes: readonly PriorityReasonCode[];
  readonly actions: readonly PriorityActionDecision[];
};
export type PriorityActionDeadlineEvidence = {
  readonly action_id: string;
  readonly deadline: PriorityDeadline | null;
};
export type PriorityEngineResultV2 = Omit<PriorityEngineResultV1, "schema_version"> & {
  readonly schema_version: 2;
  readonly deadline_evidence: readonly PriorityActionDeadlineEvidence[];
};
export type PriorityEngineResult = PriorityEngineResultV1 | PriorityEngineResultV2;
