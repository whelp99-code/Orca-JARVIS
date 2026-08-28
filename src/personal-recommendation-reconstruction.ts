import type {
  Evidence,
  EvidenceId,
  Sha256Digest,
  SourceId,
  UtcTimestamp,
} from "./personal-contracts.js";
import type { PersistenceRow } from "./personal-persistence-values.js";
import { persistenceText } from "./personal-persistence-values.js";
import type {
  ReconstructedContextEvidence,
  ReconstructedMemoryEvidenceBinding,
} from "./personal-recommendation-types.js";

function evidenceId(value: unknown): EvidenceId {
  const text = persistenceText(value);
  function valid(candidate: string): candidate is EvidenceId {
    return /^evi:pos:v1:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate);
  }
  if (!valid(text)) throw new TypeError("stored evidence id required");
  return text;
}

function sourceId(value: unknown): SourceId {
  const text = persistenceText(value);
  function valid(candidate: string): candidate is SourceId {
    return /^src:pos:v1:[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9-]{0,63}$/.test(candidate);
  }
  if (!valid(text)) throw new TypeError("stored source id required");
  return text;
}

function digest(value: unknown): Sha256Digest {
  const text = persistenceText(value);
  function valid(candidate: string): candidate is Sha256Digest {
    return /^sha256:[0-9a-f]{64}$/.test(candidate);
  }
  if (!valid(text)) throw new TypeError("stored digest required");
  return text;
}

function timestamp(value: unknown): UtcTimestamp {
  const text = persistenceText(value);
  function valid(candidate: string): candidate is UtcTimestamp {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate)
      && new Date(Date.parse(candidate)).toISOString() === candidate;
  }
  if (!valid(text)) throw new TypeError("stored timestamp required");
  return text;
}

export function reconstructedEvidence(row: PersistenceRow): Evidence {
  return {
    evidence_id: evidenceId(row["evidence_id"]),
    source_id: sourceId(row["source_id"]),
    digest: digest(row["digest"]),
    kind: persistenceText(row["kind"]),
    observed_at: timestamp(row["observed_at"]),
  };
}

export function reconstructedContextEvidence(row: PersistenceRow): ReconstructedContextEvidence {
  return { ...reconstructedEvidence(row), fresh_until: timestamp(row["fresh_until"]) };
}

export function reconstructedMemoryEvidence(row: PersistenceRow): ReconstructedMemoryEvidenceBinding {
  return {
    ...reconstructedContextEvidence(row),
    memory_ref: persistenceText(row["memory_ref"]),
  };
}
