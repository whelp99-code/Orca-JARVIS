import type { KeyObject } from "node:crypto";
import type { MorningBriefPriority } from "./morning-brief-types.js";

export type CloseoutCitation = { readonly source_id: string; readonly evidence_id: string };
export type CloseoutReadiness = "ready" | "degraded" | "no_data";
export type CloseoutVerification = {
  readonly outcome: "passed" | "failed" | "missing";
  readonly evidence_id: string | null;
  readonly evidence_digest: string | null;
};
export type CloseoutRecord = {
  readonly item_id: string;
  readonly outcome: "completed" | "open" | "failed" | "worker_done";
  readonly reason: string | null;
  readonly copy: string;
  readonly citations: readonly CloseoutCitation[];
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly trust: "trusted" | "untrusted" | "conflicting";
  readonly verification: CloseoutVerification;
};
export type CloseoutDecision = {
  readonly decision_id: string; readonly state: "made" | "owner_required";
  readonly copy: string; readonly citations: readonly CloseoutCitation[];
};
export type CloseoutMemoryCandidate = {
  readonly candidate_id: string; readonly eligible: boolean; readonly citations: readonly CloseoutCitation[];
};
export type CloseoutTomorrowAction = {
  readonly action_id: string; readonly rank: number; readonly disposition: "executable" | "delegated";
  readonly citations: readonly CloseoutCitation[]; readonly priority?: MorningBriefPriority;
};
export type CloseoutRisk = {
  readonly risk_id: string; readonly copy: string; readonly citations: readonly CloseoutCitation[];
};
export type EveningCloseoutLimits = {
  readonly max_items: number; readonly max_evidence_per_item: number; readonly max_candidates: number;
  readonly max_copy_bytes: number; readonly max_total_bytes: number;
};
export type EveningCloseoutInput = {
  readonly schema_version: 1; readonly run_id: string; readonly correlation_id: string; readonly local_date: string;
  readonly generated_at: string; readonly source_readiness: CloseoutReadiness; readonly source_omissions: readonly string[];
  readonly records: readonly CloseoutRecord[]; readonly decisions: readonly CloseoutDecision[];
  readonly memory_candidates: readonly CloseoutMemoryCandidate[]; readonly tomorrow_actions: readonly CloseoutTomorrowAction[];
  readonly risks: readonly CloseoutRisk[]; readonly limits: EveningCloseoutLimits;
};
export type CloseoutFact = {
  readonly item_id: string; readonly copy: string; readonly citations: readonly CloseoutCitation[];
  readonly verification_evidence_id: string;
};
export type CloseoutOpenFact = {
  readonly item_id: string; readonly state: "open" | "failed" | "uncertain"; readonly reason: string;
  readonly copy: string; readonly citations: readonly CloseoutCitation[];
};
export type EveningCloseoutArtifact = {
  readonly schema_version: 1; readonly artifact_id: string; readonly run_id: string; readonly correlation_id: string;
  readonly local_date: string; readonly generated_at: string; readonly source_readiness: CloseoutReadiness;
  readonly source_omissions: readonly string[]; readonly verified_completions: readonly CloseoutFact[];
  readonly open_or_failed: readonly CloseoutOpenFact[]; readonly decisions_made: readonly CloseoutDecision[];
  readonly owner_decisions_required: readonly CloseoutDecision[]; readonly eligible_memory_candidate_ids: readonly string[];
  readonly tomorrow_first_action: "none" | { readonly action_id: string; readonly citations: readonly CloseoutCitation[] };
  readonly unresolved_risks: readonly CloseoutRisk[]; readonly limits: EveningCloseoutLimits;
  readonly canonical_digest: string; readonly key_id: string; readonly algorithm: "Ed25519"; readonly signature: string;
};
export type CloseoutSigner = { readonly key_id: string; readonly private_key: KeyObject; readonly clock: () => Date };
export type CloseoutVerifier = { readonly key_id: string; readonly public_key: KeyObject | string };
export type EveningCloseoutErrorCode = "EVENING_CLOSEOUT_INPUT_INVALID" | "EVENING_CLOSEOUT_INTEGRITY_FAILURE" | "EVENING_CLOSEOUT_IDENTITY_CONFLICT";
export class EveningCloseoutError extends Error {
  readonly name = "EveningCloseoutError";
  constructor(readonly code: EveningCloseoutErrorCode) { super(code); }
}
