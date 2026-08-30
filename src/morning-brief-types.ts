import type {
  PriorityCustomerImpact,
  PriorityDeadlineBucket,
  PriorityDependencyBlocking,
  PriorityEffortCost,
  PriorityIrreversibleRisk,
  PriorityOwnerSafetyGate,
} from "./priority-engine-contracts.js";

export const MORNING_BRIEF_OMISSION_REASONS = [
  "stale", "expired", "deleted", "corrupt", "untrusted", "conflicting", "unrelated", "insufficient_citation",
  "section_cap", "total_cap", "citation_cap",
] as const;
export type MorningBriefOmissionReason = (typeof MORNING_BRIEF_OMISSION_REASONS)[number];
export const MORNING_BRIEF_EXTERNAL_STATES = ["off", "available", "missing", "late", "failed", "capped", "incompatible", "stale"] as const;
export type MorningBriefExternalState = (typeof MORNING_BRIEF_EXTERNAL_STATES)[number];
export type MorningBriefLimits = {
  readonly max_needs_you_first: number;
  readonly max_waiting: number;
  readonly max_fyi: number;
  readonly max_total_items: number;
  readonly max_sources_per_item: number;
  readonly max_copy_bytes: number;
  readonly max_total_bytes: number;
};
export type MorningBriefPriority = {
  readonly owner_safety_gate: PriorityOwnerSafetyGate;
  readonly customer_impact: PriorityCustomerImpact;
  readonly deadline_bucket: PriorityDeadlineBucket;
  readonly dependency_blocking: PriorityDependencyBlocking;
  readonly irreversible_risk: PriorityIrreversibleRisk;
  readonly effort_cost: PriorityEffortCost;
  readonly stable_identity: string;
};
export type MorningBriefCitation = {
  readonly link_id: string;
  readonly source_id: string;
  readonly evidence_ref: string;
};
export type MorningBriefRecordState =
  | "actionable" | "blocked" | "deferred" | "dependency_waiting" | "information"
  | "stale" | "expired" | "deleted" | "corrupt" | "untrusted" | "conflicting" | "unrelated" | "insufficient_citation";
export type MorningBriefRecord = {
  readonly item_id: string;
  readonly recommendation_id: string;
  readonly action_id: string;
  readonly semantic_key: string;
  readonly kind: "action" | "information";
  readonly state: MorningBriefRecordState;
  readonly copy: string;
  readonly source_ids: readonly string[];
  readonly citations: readonly MorningBriefCitation[];
  readonly observed_at: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly fresh_until: string;
  readonly trust: "confirmed" | "inferred" | "untrusted";
  readonly confidence: "low" | "medium" | "high";
  readonly owner_decision_required: boolean;
  readonly deadline: string | null;
  readonly priority: MorningBriefPriority;
  readonly provenance_digest: string;
  readonly canonical_digest: string;
};
export type MorningBriefInput = {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly context_readiness: "ready" | "degraded" | "no_data";
  readonly external_intelligence: { readonly enabled: boolean; readonly state: MorningBriefExternalState };
  readonly limits: MorningBriefLimits;
  readonly items: readonly MorningBriefRecord[];
};
export type MorningBriefItem = {
  readonly item_id: string;
  readonly recommendation_id: string;
  readonly action_id: string;
  readonly contributing_item_ids: readonly string[];
  readonly contributing_recommendation_ids: readonly string[];
  readonly contributing_action_ids: readonly string[];
  readonly source_ids: readonly string[];
  readonly citations: readonly MorningBriefCitation[];
  readonly copy: string;
  readonly observed_at: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly fresh_until: string;
  readonly trust: "confirmed" | "inferred";
  readonly confidence: "low" | "medium" | "high";
  readonly owner_decision_required: boolean;
  readonly deadline: string | null;
  readonly priority: MorningBriefPriority;
  readonly provenance_digest: string;
  readonly canonical_digest: string;
};
export type MorningBriefOmission = { readonly reason: MorningBriefOmissionReason; readonly count: number };
export type MorningBriefResult = {
  readonly schema_version: 1;
  readonly brief_id: string;
  readonly generated_at: string;
  readonly context_readiness: "ready" | "degraded" | "no_data";
  readonly needs_you_first: readonly MorningBriefItem[];
  readonly waiting: readonly MorningBriefItem[];
  readonly fyi: readonly MorningBriefItem[];
  readonly omissions: readonly MorningBriefOmission[];
  readonly omitted_count: number;
  readonly degradation_reasons: readonly string[];
  readonly abstention_reasons: readonly string[];
  readonly external_intelligence: { readonly enabled: boolean; readonly skip_reason: string | null };
  readonly limits: MorningBriefLimits;
  readonly canonical_digest: string;
};
