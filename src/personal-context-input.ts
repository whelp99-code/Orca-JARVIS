import { PERSONAL_TEXT_BYTES_MAX } from "./personal-contracts.js";
import type {
  EvidenceId,
  Sha256Digest,
  SourceId,
  UtcTimestamp,
} from "./personal-contracts.js";
import { PersonalContractError, parseContextSnapshotV1 } from "./personal-validation.js";
import type {
  ParsedContextMemoryEvidenceBinding,
  ParsedContextPersistenceInput,
} from "./personal-context-types.js";
import type { PersistenceErrorFactory, PersistenceRow } from "./personal-persistence-values.js";
import { isPersistenceRow } from "./personal-persistence-values.js";

function closed(value: PersistenceRow, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function evidenceId(value: unknown): EvidenceId | undefined {
  function valid(candidate: string): candidate is EvidenceId {
    return /^evi:pos:v1:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate);
  }
  return typeof value === "string" && valid(value) ? value : undefined;
}

function sourceId(value: unknown): SourceId | undefined {
  function valid(candidate: string): candidate is SourceId {
    return /^src:pos:v1:second-brain:[a-z0-9][a-z0-9-]{0,63}$/.test(candidate);
  }
  return typeof value === "string" && valid(value) ? value : undefined;
}

function digest(value: unknown): Sha256Digest | undefined {
  function valid(candidate: string): candidate is Sha256Digest {
    return /^sha256:[0-9a-f]{64}$/.test(candidate);
  }
  return typeof value === "string" && valid(value) ? value : undefined;
}

function timestamp(value: unknown): UtcTimestamp | undefined {
  function valid(candidate: string): candidate is UtcTimestamp {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate)
      && new Date(Date.parse(candidate)).toISOString() === candidate;
  }
  return typeof value === "string" && valid(value) ? value : undefined;
}

function binding(value: unknown, error: PersistenceErrorFactory): ParsedContextMemoryEvidenceBinding {
  if (!isPersistenceRow(value)
    || !closed(value, ["memory_ref", "evidence_id", "source_id", "digest", "observed_at", "fresh_until"])) {
    throw error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
  }
  const memoryRef = value["memory_ref"];
  const parsedEvidenceId = evidenceId(value["evidence_id"]);
  const parsedSourceId = sourceId(value["source_id"]);
  const parsedDigest = digest(value["digest"]);
  const observedAt = timestamp(value["observed_at"]);
  const freshUntil = timestamp(value["fresh_until"]);
  if (typeof memoryRef !== "string" || memoryRef.length === 0 || Buffer.byteLength(memoryRef) > 4_096
    || parsedEvidenceId === undefined || parsedSourceId === undefined || parsedDigest === undefined
    || observedAt === undefined || freshUntil === undefined || Date.parse(freshUntil) <= Date.parse(observedAt)) {
    throw error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
  }
  return {
    memory_ref: memoryRef,
    evidence_id: parsedEvidenceId,
    source_id: parsedSourceId,
    digest: parsedDigest,
    observed_at: observedAt,
    fresh_until: freshUntil,
  };
}

function oversized(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return Buffer.byteLength(value) > PERSONAL_TEXT_BYTES_MAX;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  if (Array.isArray(value) && value.length > 32) return true;
  seen.add(value);
  return Object.values(value).some(item => oversized(item, seen));
}

export function parseContextPersistenceInput(
  value: unknown,
  error: PersistenceErrorFactory,
): ParsedContextPersistenceInput {
  if (!isPersistenceRow(value) || !closed(value, ["context", "memory_evidence"])
    || !Array.isArray(value["memory_evidence"]) || value["memory_evidence"].length > 32) {
    throw error("PERSONAL_CONTEXT_INVALID");
  }
  const rawContext = value["context"];
  if (isPersistenceRow(rawContext)) {
    const payload = rawContext["payload"];
    const freshness = rawContext["freshness"];
    if (isPersistenceRow(payload) && payload["state"] === "sufficient"
      && isPersistenceRow(freshness) && freshness["state"] !== "fresh") {
      throw error("PERSONAL_CONTEXT_FRESHNESS_CONFLICT");
    }
  }
  let context;
  try {
    context = parseContextSnapshotV1(rawContext);
  } catch (caught) {
    if (caught instanceof PersonalContractError) {
      throw error(oversized(rawContext) ? "PERSONAL_CONTEXT_OVERSIZE" : "PERSONAL_CONTEXT_INVALID");
    }
    throw caught;
  }
  const bindings = value["memory_evidence"].map(item => binding(item, error));
  if (new Set(bindings.map(item => item.memory_ref)).size !== bindings.length
    || new Set(bindings.map(item => item.evidence_id)).size !== bindings.length) {
    throw error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
  }
  return { context, memory_evidence: bindings };
}
