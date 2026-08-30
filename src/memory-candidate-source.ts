import { containsMemorySecret } from "./memory-candidate-private.js";
import {
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  MEMORY_CANDIDATE_INPUT_CLASSES,
  MEMORY_CANDIDATE_REF_KINDS,
  type MemoryCandidateInputClass,
  type ParsedMemoryReference,
  type ParsedMemorySource,
} from "./memory-candidate-types.js";
import {
  memoryArray,
  memoryDigest,
  memoryFail,
  memoryHash,
  memoryInstant,
  memoryMember,
  memoryRecord,
  memoryText,
} from "./memory-candidate-values.js";

const REFERENCE_KEYS = ["kind", "source_ref", "evidence_digest", "observed_at", "fresh_until", "expires_at"] as const;
const BASE_SOURCE_KEYS = ["class", "source_id", "source_version", "references"] as const;
const EXPLICIT_KEYS = [
  "class", "source_id", "source_version", "instruction_id", "principal_id", "authenticated_session_id", "references",
] as const;
const VERIFIED_KEYS = [
  "class", "source_id", "source_version", "outcome_id", "worker_id", "verifier_id", "verdict", "machine_outcome",
  "references",
] as const;
const DECISION_KEYS = [
  "class", "source_id", "source_version", "request_id", "receipt_id", "command_digest", "signer_principal_id",
  "authenticated_session_id", "issued_at", "expires_at",
] as const;
const INFERENCE_KEYS = [
  "class", "source_id", "source_version", "inference_id", "label", "references",
] as const;

function provenanceText(value: unknown, maximum = 512): string {
  const parsed = memoryText(value, maximum);
  return containsMemorySecret(parsed) ? memoryFail() : parsed;
}

function reference(value: unknown): ParsedMemoryReference {
  const input = memoryRecord(value, REFERENCE_KEYS);
  const observedAt = memoryInstant(input["observed_at"]);
  const freshUntil = memoryInstant(input["fresh_until"]);
  const expiresAt = memoryInstant(input["expires_at"]);
  if (Date.parse(observedAt) >= Date.parse(freshUntil) || Date.parse(freshUntil) > Date.parse(expiresAt)) {
    return memoryFail();
  }
  return {
    kind: memoryMember(input["kind"], MEMORY_CANDIDATE_REF_KINDS),
    source_ref: provenanceText(input["source_ref"]),
    evidence_digest: memoryDigest(input["evidence_digest"]),
    observed_at: observedAt,
    fresh_until: freshUntil,
    expires_at: expiresAt,
  };
}

export function parseMemoryReferences(value: unknown, allowEmpty = false): readonly ParsedMemoryReference[] {
  const parsed = memoryArray(value, 16).map(reference);
  if ((!allowEmpty && parsed.length === 0)
    || new Set(parsed.map(item => item.source_ref)).size !== parsed.length) return memoryFail();
  return parsed;
}

function baseSource(input: Readonly<Record<string, unknown>>): Pick<ParsedMemorySource, "source_id" | "source_version"> {
  return {
    source_id: provenanceText(input["source_id"]),
    source_version: provenanceText(input["source_version"], 128),
  };
}

function emptyMetadata(
  inputClass: MemoryCandidateInputClass,
  input: Readonly<Record<string, unknown>>,
  parsedReferences: readonly ParsedMemoryReference[],
): ParsedMemorySource {
  return {
    input_class: inputClass,
    ...baseSource(input),
    principal_id: null,
    authenticated_session_id: null,
    worker_id: null,
    verifier_id: null,
    request_id: null,
    receipt_id: null,
    command_digest: null,
    inference_label: null,
    outcome_id: null,
    instruction_id: null,
    inference_id: null,
    verdict: null,
    machine_outcome: null,
    issued_at: null,
    source_expires_at: null,
    references: parsedReferences,
  };
}

function explicitSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, EXPLICIT_KEYS);
  const parsedReferences = parseMemoryReferences(input["references"]);
  if (parsedReferences.length !== 2 || parsedReferences[0]?.kind !== "owner_instruction"
    || parsedReferences[1]?.kind !== "owner_session") return memoryFail();
  return {
    ...emptyMetadata("explicit_user_instruction", input, parsedReferences),
    principal_id: provenanceText(input["principal_id"]),
    authenticated_session_id: provenanceText(input["authenticated_session_id"]),
    instruction_id: provenanceText(input["instruction_id"]),
  };
}

function verifiedSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, VERIFIED_KEYS);
  const parsedReferences = parseMemoryReferences(input["references"]);
  if (parsedReferences.length < 2 || parsedReferences[0]?.kind !== "verification"
    || parsedReferences.slice(1).some(item => item.kind !== "artifact")) return memoryFail();
  return {
    ...emptyMetadata("verified_outcome", input, parsedReferences),
    outcome_id: provenanceText(input["outcome_id"]),
    worker_id: provenanceText(input["worker_id"]),
    verifier_id: provenanceText(input["verifier_id"]),
    verdict: memoryMember(input["verdict"], ["passed", "failed", "uncertain"] as const),
    machine_outcome: memoryMember(input["machine_outcome"], ["succeeded", "failed", "unknown"] as const),
  };
}

function decisionSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, DECISION_KEYS);
  const issuedAt = memoryInstant(input["issued_at"]);
  const expiresAt = memoryInstant(input["expires_at"]);
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) return memoryFail();
  const requestId = provenanceText(input["request_id"]);
  const receiptId = provenanceText(input["receipt_id"]);
  const commandDigest = memoryDigest(input["command_digest"]);
  const core = {
    request_id: requestId,
    receipt_id: receiptId,
    command_digest: commandDigest,
    signer_principal_id: provenanceText(input["signer_principal_id"]),
    authenticated_session_id: provenanceText(input["authenticated_session_id"]),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const parsedReferences: readonly ParsedMemoryReference[] = [{
    kind: "verification",
    source_ref: requestId,
    evidence_digest: commandDigest,
    observed_at: issuedAt,
    fresh_until: expiresAt,
    expires_at: expiresAt,
  }, {
    kind: "artifact",
    source_ref: receiptId,
    evidence_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.decisionReceipt, core),
    observed_at: issuedAt,
    fresh_until: expiresAt,
    expires_at: expiresAt,
  }];
  return {
    ...emptyMetadata("approved_decision", input, parsedReferences),
    principal_id: core.signer_principal_id,
    authenticated_session_id: core.authenticated_session_id,
    request_id: requestId,
    receipt_id: receiptId,
    command_digest: commandDigest,
    issued_at: issuedAt,
    source_expires_at: expiresAt,
  };
}

function inferenceSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value, INFERENCE_KEYS);
  const parsedReferences = parseMemoryReferences(input["references"]);
  if (parsedReferences.some(item => item.kind !== "inference_evidence")) return memoryFail();
  return {
    ...emptyMetadata("labeled_inference", input, parsedReferences),
    inference_id: provenanceText(input["inference_id"]),
    inference_label: memoryMember(input["label"], ["inference"] as const),
  };
}

function rejectedSource(value: unknown, inputClass: MemoryCandidateInputClass): ParsedMemorySource {
  const input = memoryRecord(value, BASE_SOURCE_KEYS);
  return emptyMetadata(inputClass, input, parseMemoryReferences(input["references"]));
}

export function parseMemoryCandidateSource(value: unknown): ParsedMemorySource {
  const input = memoryRecord(value);
  const inputClass = memoryMember(input["class"], MEMORY_CANDIDATE_INPUT_CLASSES);
  switch (inputClass) {
    case "explicit_user_instruction": return explicitSource(input);
    case "verified_outcome": return verifiedSource(input);
    case "approved_decision": return decisionSource(input);
    case "labeled_inference": return inferenceSource(input);
    case "raw_transcript":
    case "worker_assertion":
    case "unverified_summary":
    case "transient_runtime":
    case "unlabeled_trait_inference":
    case "model_assertion":
      return rejectedSource(input, inputClass);
    default: {
      const exhaustive: never = inputClass;
      return exhaustive;
    }
  }
}
