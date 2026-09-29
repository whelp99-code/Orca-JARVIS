export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_TOPICS = ["memory.records.v1", "memory.conflicts.v1", "memory.candidates.v1",
  "memory.effects.v1", "memory.privacy.v1", "memory.status.v1"] as const;
export type MemoryTopic = (typeof MEMORY_TOPICS)[number];
export const MEMORY_ERROR_CODES = ["MEMORY_INPUT_INVALID", "MEMORY_REQUEST_TOO_LARGE",
  "MEMORY_RESPONSE_TOO_LARGE", "MEMORY_QUERY_INVALID", "MEMORY_QUERY_PROHIBITED",
  "MEMORY_CONTENT_PROHIBITED", "MEMORY_CURSOR_INVALID", "MEMORY_INTENT_INVALID",
  "MEMORY_POLICY_FORBIDDEN", "MEMORY_SENSITIVE_REDACTED", "MEMORY_RESOURCE_NOT_FOUND",
  "MEMORY_SELECTION_STALE", "MEMORY_SELECTION_EXPIRED", "MEMORY_GENERATION_CHANGED",
  "MEMORY_STATE_CONFLICT", "MEMORY_INTENT_REPLAY_CONFLICT", "MEMORY_TARGET_AMBIGUOUS",
  "MEMORY_TOMBSTONE_STALE", "MEMORY_CANDIDATE_EXPIRED", "MEMORY_INTENT_EXPIRED",
  "MEMORY_REVIEW_UNAVAILABLE", "MEMORY_TARGET_UNRESOLVED", "MEMORY_EXTERNAL_RECEIPT_REQUIRED",
  "MEMORY_PROVIDER_OFFLINE", "MEMORY_PROVIDER_UNAVAILABLE", "MEMORY_PROVIDER_INCOMPATIBLE",
  "MEMORY_PROVIDER_SPLIT_BRAIN", "MEMORY_EFFECT_SERVICE_UNAVAILABLE"] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];
export type MemoryResourceState = "ready" | "stale" | "no_data" | "offline" | "unavailable" | "incompatible";
/** One authority-side event on a record: an owner command attempt or an approved suppression. */
export type MemoryRecordHistoryEntry = {
  readonly operation: "correct" | "forget" | "export";
  /** Effect attempt state, or `suppressed` once an approval receipt made it effective. */
  readonly state: string;
  readonly request_id: string;
  readonly receipt_id: string | null;
  readonly at: string;
};
export type MemoryPublicRecord = {
  readonly record_token: string; readonly record_revision: string; readonly title: string;
  readonly excerpt: string | null; readonly citation: string; readonly sensitivity: string;
  readonly retention: { readonly source: "policy"; readonly days: number; readonly expires_at: string };
  readonly freshness: string; readonly provenance: { readonly source_class: "memory";
    readonly owner_class: string; readonly origin_label: string; readonly origin_revision: string | null };
  readonly conflict_state: "none" | "unresolved"; readonly history_state: "current" | "superseded";
  readonly superseded_by: string | null;
  readonly history: readonly MemoryRecordHistoryEntry[];
  readonly actions: readonly ("inspect" | "correct" | "forget" | "export")[];
};
