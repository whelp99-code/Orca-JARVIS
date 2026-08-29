export const PERSONAL_OS_SCENARIO_CLASSES = [
  "exact_source", "multi_session", "before_after", "supersession", "principle_vs_inference",
  "conflict_abstention", "stale_abstention", "no_data_abstention", "unrelated_exclusion",
  "injection_isolation", "tombstone_restore", "deletion_prevention", "linux_offline_clients",
  "transfer_integrity", "duplicate_evidence", "owner_gated_decision",
] as const;
export type PersonalOsScenarioClass = (typeof PERSONAL_OS_SCENARIO_CLASSES)[number];
export type PersonalOsOutcome = "answer" | "abstain" | "reject" | "decision";
export type PersonalOsEffectEvent = "unauthorized" | "approval_bypass" | "duplicate" | "stale_authoritative" | "deletion_leak";
export type PersonalOsDependencies = { readonly model_calls: number; readonly network_calls: number; readonly mac_calls: number };
export type PersonalOsRecord = {
  readonly id: string; readonly subject: string; readonly value: string;
  readonly kind: "fact" | "principle" | "gap"; readonly state: "active" | "stale" | "deleted" | "no_data";
  readonly trust: "confirmed" | "inferred" | "untrusted"; readonly authority: "none" | "owner";
  readonly observed_at: string; readonly valid_from: string; readonly valid_until: string; readonly fresh_until: string;
  readonly digest: string; readonly transfer_digest: string; readonly evidence_link: string; readonly session_id: string;
  readonly relationship: "direct" | "supporting" | "unrelated";
};
export type PersonalOsExpected = {
  readonly outcome: PersonalOsOutcome; readonly record_ids: readonly string[];
  readonly citation_links: readonly string[]; readonly value: string | null; readonly reason_code: string;
};
export type PersonalOsScenario = {
  readonly id: string; readonly class: PersonalOsScenarioClass; readonly query_subject: string;
  readonly query_at: string; readonly records: readonly PersonalOsRecord[]; readonly expected: PersonalOsExpected;
};
export type PersonalOsCorpus = {
  readonly schema_version: 1; readonly corpus_id: string; readonly fixed_clock: string;
  readonly scenarios: readonly PersonalOsScenario[];
};
export type PersonalOsActualTrace = {
  readonly schema_version: 1; readonly scenario_id: string; readonly outcome: PersonalOsOutcome; readonly selected_record_ids: readonly string[];
  readonly citation_links: readonly string[]; readonly session_ids: readonly string[]; readonly value: string | null;
  readonly reason_code: string; readonly temporal_observation: boolean; readonly effect_events: readonly PersonalOsEffectEvent[];
  readonly dependencies: PersonalOsDependencies;
};
export type PersonalOsAssertion = {
  readonly id: string; readonly passed: boolean; readonly metric: "task_quality" | "temporal" | "abstention" | "safety";
  readonly memory_tp: number; readonly memory_fp: number; readonly memory_fn: number;
  readonly temporal_correct: number; readonly temporal_total: number; readonly abstained: number; readonly abstention_total: number;
  readonly unauthorized_effects: number; readonly approval_bypass_effects: number; readonly duplicate_effects: number;
  readonly stale_authoritative_effects: number; readonly deletion_leak_effects: number;
};
export type PersonalOsScenarioResult = PersonalOsActualTrace & {
  readonly scenario_class: PersonalOsScenarioClass; readonly assertions: readonly PersonalOsAssertion[];
};
export type CountRate = { readonly passed: number; readonly total: number; readonly rate: number };
export type Precision = { readonly tp: number; readonly fp: number; readonly rate: number };
export type Recall = { readonly tp: number; readonly fn: number; readonly rate: number };
export type PersonalOsEvaluationResult = {
  readonly schema_version: 1; readonly corpus_id: string; readonly fixed_clock: string; readonly verdict: "pass" | "fail";
  readonly failed_reason_codes: readonly string[]; readonly scenario_count: number; readonly assertion_count: number;
  readonly task_quality: CountRate; readonly memory_precision: Precision; readonly memory_recall: Recall;
  readonly temporal: { readonly correct: number; readonly total: number; readonly accuracy: number };
  readonly stale_no_data_abstention: { readonly abstained: number; readonly total: number; readonly rate: number };
  readonly safety: { readonly unauthorized_effects: number; readonly approval_bypass_effects: number;
    readonly duplicate_effects: number; readonly stale_authoritative_effects: number; readonly deletion_leak_effects: number };
  readonly dependencies: PersonalOsDependencies; readonly scenarios: readonly PersonalOsScenarioResult[];
};
