import { containsMemoryPromptText, containsMemorySecret } from "./memory-candidate-private.js";
import {
  MEMORY_CANDIDATE_INPUT_CLASSES,
  MEMORY_CANDIDATE_REF_KINDS,
  MEMORY_CANDIDATE_REF_NAMESPACES,
  type MemoryCandidateInputClass,
  type MemoryCandidateRefKind,
  type MemoryCandidateRefNamespace,
  type ParsedMemoryReference,
  type ParsedMemorySource,
} from "./memory-candidate-types.js";
import { memoryArray, memoryDigest, memoryFail, memoryInstant, memoryMember, memoryRecord, memoryText } from "./memory-candidate-values.js";

const IDENTIFIER_KEYS = ["namespace", "id", "version"] as const;
const REFERENCE_KEYS = ["kind", "identifier", "evidence_digest", "observed_at", "fresh_until", "expires_at"] as const;
const BASE_SOURCE_KEYS = ["class", "source_id", "source_version", "references"] as const;
const CONTROL_SOURCE_KEYS = ["class", "source_id", "source_version", "request_id", "receipt_id"] as const;
const VERIFIED_KEYS = ["class", "source_id", "source_version", "evidence_id"] as const;
const INFERENCE_KEYS = ["class", "source_id", "source_version", "inference_id", "label", "references"] as const;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPAQUE_REFERENCE_ID = /^[0-9a-f]{64}$/;
const PRIVATE_ID_WORD = new RegExp(
  "(?:^|[_-])(?:password|passwd|secret|token|access[_-]?token|refresh[_-]?token|client[_-]?secret"
    + "|api[_-]?key|authorization|cookie)(?:[_-]|$)",
  "i",
);

const namespaceByKind: Readonly<Record<MemoryCandidateRefKind, readonly MemoryCandidateRefNamespace[]>> = {
  verification: ["control_command", "verification_authority"],
  artifact: ["control_receipt", "verification_artifact"],
  owner_instruction: ["control_command"],
  owner_session: ["control_receipt"],
  inference_evidence: ["inference_evidence"],
  existing_memory: ["memory_candidate"],
  second_brain_conflict: ["second_brain_conflict"],
  transcript: ["rejected_input"],
  unverified: ["rejected_input"],
};

export function memoryOpaqueId(value: unknown): string {
  const parsed = memoryText(value, 128);
  const semantic = parsed.replace(/[_-]+/g, " ");
  if (!OPAQUE_ID.test(parsed) || PRIVATE_ID_WORD.test(parsed) || containsMemorySecret(parsed) || containsMemorySecret(semantic)
    || containsMemoryPromptText(parsed) || containsMemoryPromptText(semantic)) return memoryFail();
  return parsed;
}

export function memoryOpaqueReferenceId(value: unknown): string {
  const parsed = memoryText(value, 64);
  return OPAQUE_REFERENCE_ID.test(parsed) ? parsed : memoryFail();
}

function identifier(value: unknown, kind: MemoryCandidateRefKind) {
  const input = memoryRecord(value, IDENTIFIER_KEYS);
  const namespace = memoryMember(input["namespace"], MEMORY_CANDIDATE_REF_NAMESPACES);
  if (input["version"] !== 1 || !namespaceByKind[kind].includes(namespace)) return memoryFail();
  return { namespace, id: memoryOpaqueReferenceId(input["id"]), version: 1 as const };
}

function reference(value: unknown): ParsedMemoryReference {
  const input = memoryRecord(value, REFERENCE_KEYS);
  const kind = memoryMember(input["kind"], MEMORY_CANDIDATE_REF_KINDS);
  const observedAt = memoryInstant(input["observed_at"]);
  const freshUntil = memoryInstant(input["fresh_until"]);
  const expiresAt = memoryInstant(input["expires_at"]);
  if (Date.parse(observedAt) >= Date.parse(freshUntil) || Date.parse(freshUntil) > Date.parse(expiresAt)) return memoryFail();
  return {
    kind,
    identifier: identifier(input["identifier"], kind),
    evidence_digest: memoryDigest(input["evidence_digest"]),
    observed_at: observedAt,
    fresh_until: freshUntil,
    expires_at: expiresAt,
  };
}

export function parseMemoryReferences(value: unknown, allowEmpty = false): readonly ParsedMemoryReference[] {
  const parsed = memoryArray(value, 16).map(reference);
  const keys = parsed.map(item => `${item.kind}\0${item.identifier.namespace}\0${item.identifier.id}\0${item.identifier.version}`);
  if ((!allowEmpty && parsed.length === 0) || new Set(keys).size !== parsed.length) return memoryFail();
  return parsed;
}

function base(
  inputClass: MemoryCandidateInputClass,
  input: Readonly<Record<string, unknown>>,
  references: readonly ParsedMemoryReference[] = [],
): ParsedMemorySource {
  return {
    input_class: inputClass,
    source_id: memoryOpaqueId(input["source_id"]),
    source_version: memoryOpaqueId(input["source_version"]),
    request_id: null,
    receipt_id: null,
    evidence_id: null,
    inference_id: null,
    inference_label: null,
    references,
  };
}

function controlSource(value: unknown, inputClass: "explicit_user_instruction" | "approved_decision"): ParsedMemorySource {
  const input = memoryRecord(value, CONTROL_SOURCE_KEYS);
  return { ...base(inputClass, input), request_id: memoryOpaqueId(input["request_id"]), receipt_id: memoryOpaqueId(input["receipt_id"]) };
}

function verifiedSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, VERIFIED_KEYS);
  return { ...base("verified_outcome", input), evidence_id: memoryOpaqueId(input["evidence_id"]) };
}

function inferenceSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, INFERENCE_KEYS);
  const references = parseMemoryReferences(input["references"]);
  if (references.some(item => item.kind !== "inference_evidence")) return memoryFail();
  return {
    ...base("labeled_inference", input, references),
    inference_id: memoryOpaqueId(input["inference_id"]),
    inference_label: memoryMember(input["label"], ["inference"] as const),
  };
}

function rejectedSource(value: unknown, inputClass: MemoryCandidateInputClass): ParsedMemorySource {
  const input = memoryRecord(value, BASE_SOURCE_KEYS);
  return base(inputClass, input, parseMemoryReferences(input["references"]));
}

export function parseMemoryCandidateSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value);
  const inputClass = memoryMember(input["class"], MEMORY_CANDIDATE_INPUT_CLASSES);
  switch (inputClass) {
    case "explicit_user_instruction": return controlSource(input, inputClass);
    case "verified_outcome": return verifiedSource(input);
    case "approved_decision": return controlSource(input, inputClass);
    case "labeled_inference": return inferenceSource(input);
    case "raw_transcript": case "worker_assertion": case "unverified_summary": case "transient_runtime":
    case "unlabeled_trait_inference": case "model_assertion": return rejectedSource(input, inputClass);
    default: { const exhaustive: never = inputClass; return exhaustive; }
  }
}
