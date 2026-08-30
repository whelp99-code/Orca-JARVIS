import type { AuthorityDb } from "./db.js";
import type { PriorityLexicographicFields } from "./priority-engine-contracts.js";

export const NOTIFICATION_ERROR_CODES = ["NOTIFICATION_INPUT_INVALID", "NOTIFICATION_IDENTITY_CONFLICT"] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];
export class NotificationIntentError extends Error {
  readonly name = "NotificationIntentError";
  constructor(readonly code: NotificationErrorCode) { super(code); }
}
export type DecisionSourceState = "active" | "stale" | "conflicted" | "deleted" | "superseded" | "corrupt" | "untrusted";
export type DecisionEventState = "pending" | "accepted" | "rejected" | "dismissed" | "snoozed" | "expired" | "superseded";
export type DecisionCitation = {
  readonly source_id: string; readonly evidence_ref: string; readonly evidence_digest: string;
  readonly observed_at: string; readonly fresh_until: string;
};
export type DecisionEvent = { readonly state: DecisionEventState; readonly occurred_at: string; readonly event_digest: string };
export type DecisionQueueRecord = {
  readonly semantic_key: string; readonly recommendation_id: string; readonly action_id: string; readonly context_id: string;
  readonly context_digest: string; readonly recommendation_digest: string; readonly evidence_digest: string;
  readonly identity_digest: string; readonly source_state: DecisionSourceState; readonly trust: "confirmed" | "untrusted";
  readonly confidence: "low" | "medium" | "high"; readonly reversible: boolean; readonly title: string;
  readonly safety: "standard" | "critical"; readonly deadline: string | null; readonly created_at: string; readonly expires_at: string;
  readonly priority: PriorityLexicographicFields; readonly source_ids: readonly string[];
  readonly citations: readonly DecisionCitation[]; readonly events: readonly DecisionEvent[];
  readonly provenance_digest: string; readonly record_digest: string;
};
export type DecisionQueueInput = { readonly schema_version: 1; readonly generated_at: string; readonly items: readonly DecisionQueueRecord[] };
export type DecisionQueueState = "needs_owner" | "snoozed" | "resolved" | "expired";
export const DECISION_OMISSION_REASONS = ["stale", "conflicted", "deleted", "superseded", "untrusted", "corrupt", "uncited",
  "resolved", "snoozed", "expired"] as const;
export type DecisionOmissionReason = (typeof DECISION_OMISSION_REASONS)[number];
export type OwnerDecisionQueueEntry = {
  readonly queue_key: string; readonly dedup_key: string; readonly thread_key: string; readonly semantic_key: string;
  readonly category: "owner_decision"; readonly resource_id: string; readonly urgency: "critical" | "action" | "digest";
  readonly title: string; readonly preview: string; readonly deep_link: string; readonly recommendation_id: string;
  readonly action_id: string; readonly context_id: string; readonly context_digest: string; readonly recommendation_digest: string;
  readonly evidence_digest: string; readonly identity_digest: string; readonly provenance_digest: string;
  readonly contributing_recommendation_ids: readonly string[]; readonly contributing_action_ids: readonly string[];
  readonly contributing_context_ids: readonly string[]; readonly contributing_evidence_digests: readonly string[];
  readonly contributing_identity_digests: readonly string[]; readonly contributing_provenance_digests: readonly string[];
  readonly source_ids: readonly string[]; readonly citations: readonly DecisionCitation[]; readonly created_at: string;
  readonly occurred_at: string; readonly expires_at: string; readonly deadline: string | null;
  readonly confidence: "low" | "medium" | "high";
  readonly reversible: boolean; readonly safety: "standard" | "critical"; readonly priority: PriorityLexicographicFields;
  readonly state: "needs_owner"; readonly semantic_digest: string;
};
export type DecisionQueueProjection = { readonly generated_at: string; readonly active: readonly OwnerDecisionQueueEntry[];
  readonly omissions: readonly { readonly semantic_key: string; readonly reason: DecisionOmissionReason }[] };
export type NotificationUrgency = "critical" | "action" | "digest" | "silent";
export type NotificationPolicyDecision = { readonly urgency: NotificationUrgency; readonly state: "queued" | "deferred" | "suppressed";
  readonly reason: string; readonly not_before: string | null; readonly intent_id: string | null };
export interface DecisionQueueEventSource { subscribe(listener: (value: unknown) => void): () => void }
export type NotificationStoreAuthority = Pick<AuthorityDb, "db">;
