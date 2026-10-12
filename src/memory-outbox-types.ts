import type { ClaimedControlCommand } from "./control-plane.js";
import type { MemoryOutboxFailure } from "./memory-outbox-diagnostic.js";
import type {
  SecondBrainReadAdapter,
  SecondBrainWriteOutcome,
  SecondBrainWriteRequestAdapter,
  SecondBrainRememberWriteRequest,
} from "./second-brain-adapter-types.js";

export const MEMORY_OUTBOX_STATES_V2 = [
  "queued", "claimed", "dispatching", "reconciling", "settled", "conflict", "failed", "expired",
] as const;
export type MemoryOutboxStateV2 = (typeof MEMORY_OUTBOX_STATES_V2)[number];
export type MemoryExpectedArtifactV2 = {
  readonly page_id: string;
  readonly sid: string;
  readonly source_digest: string;
};
export type MemoryOutboxActionV2 = {
  readonly command: ClaimedControlCommand;
  readonly request: SecondBrainRememberWriteRequest;
  readonly dispatch_spool_digest?: string;
  readonly expected_artifact: MemoryExpectedArtifactV2;
};
export type MemoryOutboxSagaV2 = {
  readonly schema_version: 2;
  readonly outbox_id: string;
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly classification_digest: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly operation: "remember" | "correct";
  readonly expected_artifact: MemoryExpectedArtifactV2;
  readonly state: MemoryOutboxStateV2;
  readonly lease_owner: string | null;
  readonly lease_fence: number;
  readonly dispatch_fence: number | null;
  readonly dispatched_at: string | null;
  readonly reconcile_deadline_at: string | null;
  readonly failure_code: string | null;
  readonly settlement_receipt_digest: string | null;
  readonly settled_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};
export type MemoryOutboxCycleResult = {
  readonly claimed: number;
  readonly dispatched: number;
  readonly reconciling: number;
  readonly settled: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly failure?: MemoryOutboxFailure;
  readonly cleanup_error?: "MEMORY_REVIEW_CLEANUP_FAILED";
  readonly commands_reconciled?: number;
  readonly control_error?: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" | "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED";
};
export type MemoryOutboxServiceOptions = {
  readonly authority: import("./db.js").AuthorityDb;
  readonly writer: SecondBrainWriteRequestAdapter;
  readonly reader: SecondBrainReadAdapter;
  readonly clock: () => Date;
  readonly leaseMs?: number;
  readonly artifactDeadlineMs?: number;
  readonly candidate_dispatch_spool_root?: string;
  readonly candidate_review_spool_root?: string;
};
export type MemoryDispatch = {
  readonly saga: MemoryOutboxSagaV2;
  readonly request: SecondBrainRememberWriteRequest;
  readonly attempt_id: string;
  readonly invocation_digest: string;
};
export type MemoryObservationDigestInput = {
  readonly outbox_id: string; readonly attempt_id: string; readonly reconcile_fence: number;
  readonly page_id: string | null; readonly sid: string | null; readonly source_version: string | null;
  readonly source_digest: string | null; readonly observed_at: string; readonly outcome: string;
};
export type MemorySettlementDigestInput = {
  readonly outbox_id: string; readonly candidate_id: string; readonly candidate_digest: string;
  readonly request_id: string; readonly request_digest: string; readonly attempt_id: string;
  readonly invocation_digest: string; readonly dispatch_fence: number;
  readonly acceptance_receipt_digest: string | null; readonly page_id: string; readonly sid: string;
  readonly source_version: string; readonly source_digest: string; readonly observation_digest: string;
  readonly reconciled_at: string;
};
export type MemoryObservation = {
  readonly kind: "missing" | "match" | "conflict";
  readonly code: string;
  readonly page_id?: string;
  readonly sid?: string;
  readonly source_version?: string;
  readonly source_digest?: string;
};
export type MemoryOutboxWriter = SecondBrainWriteRequestAdapter;
export type MemoryOutboxReader = SecondBrainReadAdapter;
export type MemoryWriteResult = SecondBrainWriteOutcome;
