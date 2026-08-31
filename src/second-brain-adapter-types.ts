import type { SecondBrainTransport } from "./second-brain-transport.js";

export const SECOND_BRAIN_SOURCE_ID = "src:pos:v1:second-brain:primary" as const;
export const SECOND_BRAIN_TRUST = "untrusted" as const;
export const SECOND_BRAIN_SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;

export type SecondBrainSensitivity = (typeof SECOND_BRAIN_SENSITIVITIES)[number];
export type SecondBrainAdapterBudgets = {
  readonly max_hits: number;
  readonly max_excerpt_bytes: number;
  readonly max_total_bytes: number;
  readonly max_page_bytes: number;
};
export type SecondBrainAdapterOptions = {
  readonly transport: SecondBrainTransport;
  readonly budgets: SecondBrainAdapterBudgets;
  readonly clock: () => Date;
  readonly max_age_ms: number;
  readonly expiry_ms: number;
  readonly read_fence?: (at: Date) => import("./second-brain-effect-v2.js").MemoryReadFenceV1;
};
export type SecondBrainEvidence = {
  readonly kind: "memory";
  readonly page_id: string;
  readonly sid: string;
  readonly source_ref: string;
  readonly source_id: typeof SECOND_BRAIN_SOURCE_ID;
  readonly source_version: string;
  readonly sensitivity: SecondBrainSensitivity;
  readonly observed_at: string;
  readonly valid_at: string;
  readonly freshness: {
    readonly state: "fresh" | "stale";
    readonly checked_at: string;
    readonly fresh_until: string;
  };
  readonly expires_at: string;
  readonly trust: typeof SECOND_BRAIN_TRUST;
  readonly authority: "none";
  readonly excerpt: string | null;
  readonly content_digest: string;
  readonly omission: "policy_redacted" | null;
};
export type SecondBrainConflict = {
  readonly conflict_id: string;
  readonly page_id: string;
  readonly state: "unresolved";
  readonly left: SecondBrainEvidence;
  readonly right: SecondBrainEvidence;
};
export type SecondBrainReadOutcome =
  | { readonly kind: "current"; readonly checked_at: string; readonly evidence: readonly SecondBrainEvidence[] }
  | { readonly kind: "no_data"; readonly checked_at: string; readonly fresh_until: string }
  | { readonly kind: "unavailable"; readonly code: string; readonly checked_at: string }
  | { readonly kind: "offline"; readonly code: string; readonly checked_at: string }
  | { readonly kind: "invalid"; readonly code: string; readonly checked_at: string }
  | {
    readonly kind: "stale";
    readonly code: "SECOND_BRAIN_EVIDENCE_STALE";
    readonly checked_at: string;
    readonly evidence: readonly SecondBrainEvidence[];
  }
  | { readonly kind: "conflicts"; readonly checked_at: string; readonly conflicts: readonly SecondBrainConflict[] };

export type SecondBrainWriteOperation = "remember" | "correct" | "forget" | "export";
export type SecondBrainWriteRequestV1 = {
  readonly schema_version: 1; readonly candidate_id: string; readonly candidate_digest: string;
  readonly classification_digest: string; readonly idempotency_key: string; readonly request_id: string;
  readonly request_digest: string; readonly operation: SecondBrainWriteOperation; readonly subject: string;
  readonly purpose: "personal_memory" | "data_erasure" | "data_portability";
  readonly sensitivity: SecondBrainSensitivity; readonly retention_days: number; readonly created_at: string;
  readonly expires_at: string; readonly expected_prior: Readonly<Record<string, string>> | null;
  readonly receipt: Readonly<Record<string, string | number>>; readonly receipt_digest: string;
  readonly payload: Readonly<Record<string, string>>;
};
export type SecondBrainWriteRequestV2 = import("./second-brain-effect-v2.js").MemoryEffectWriteRequestV2;
export type SecondBrainWriteRequest = SecondBrainWriteRequestV1 | SecondBrainWriteRequestV2;
export type SecondBrainWriteAcceptedV1 = {
  readonly schema_version?: 1; readonly kind: "accepted"; readonly state: "pending"; readonly candidate_id: string;
  readonly request_id: string; readonly request_digest: string; readonly idempotency_key: string;
  readonly operation: SecondBrainWriteOperation; readonly accepted_at: string; readonly inbox_path: string;
  readonly request_file_digest: string; readonly replayed: boolean;
};
export type SecondBrainWriteOutcome =
  | SecondBrainWriteAcceptedV1
  | import("./second-brain-effect-v2.js").MemoryEffectAcceptedV2
  | { readonly kind: "invalid" | "unavailable" | "uncertain"; readonly code: string };
export interface SecondBrainWriteRequestAdapter { write(value: unknown): Promise<SecondBrainWriteOutcome>; }

export interface SecondBrainReadAdapter {
  search(query: string): Promise<SecondBrainReadOutcome>;
  readPage(pageId: string): Promise<SecondBrainReadOutcome>;
  recentChanges(days: number): Promise<SecondBrainReadOutcome>;
  openConflicts(): Promise<SecondBrainReadOutcome>;
}
