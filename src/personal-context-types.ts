import type {
  ContextId,
  ContextSnapshotV1,
  EvidenceId,
  Sha256Digest,
  SourceId,
  UtcTimestamp,
} from "./personal-contracts.js";

export type ContextMemoryEvidenceBinding = {
  readonly memory_ref: string;
  readonly evidence_id: string;
  readonly source_id: string;
  readonly digest: string;
  readonly observed_at: string;
  readonly fresh_until: string;
};

export type ParsedContextMemoryEvidenceBinding = {
  readonly memory_ref: string;
  readonly evidence_id: EvidenceId;
  readonly source_id: SourceId;
  readonly digest: Sha256Digest;
  readonly observed_at: UtcTimestamp;
  readonly fresh_until: UtcTimestamp;
};

export type ContextPersistenceInput = {
  readonly context: unknown;
  readonly memory_evidence: readonly ContextMemoryEvidenceBinding[];
};

export type ParsedContextPersistenceInput = {
  readonly context: ContextSnapshotV1;
  readonly memory_evidence: readonly ParsedContextMemoryEvidenceBinding[];
};

export type StoredContext = {
  readonly context_id: ContextId;
  readonly canonical_digest: Sha256Digest;
  readonly version: number;
  readonly observation_count: number;
  readonly evidence_count: number;
};
