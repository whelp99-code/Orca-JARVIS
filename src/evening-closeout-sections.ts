import {
  closeoutHash,
  EVENING_VERIFICATION_DOMAIN,
  parseCloseoutEnvelope,
  verifyCloseoutSignature,
} from "./evening-closeout-crypto.js";
import {
  closedArray,
  closedObject,
  closeoutBoolean,
  closeoutDigest,
  closeoutInstant,
  closeoutMember,
  closeoutText,
  invalidCloseout,
} from "./evening-closeout-parse-values.js";
import type {
  CloseoutCitation,
  CloseoutDecision,
  CloseoutMemoryCandidate,
  CloseoutPriority,
  CloseoutRecord,
  CloseoutRisk,
  CloseoutTomorrowAction,
  CloseoutVerification,
  TrustedCloseoutVerifier,
} from "./evening-closeout-types.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";

export function parseCloseoutCitation(value: unknown): CloseoutCitation {
  const input = closedObject(value, ["citation_id", "source_id", "evidence_id"]);
  return {
    citation_id: closeoutText(input["citation_id"]),
    source_id: closeoutText(input["source_id"]),
    evidence_id: closeoutText(input["evidence_id"]),
  };
}
export function parseCloseoutCitations(value: unknown, maximum = 128): readonly CloseoutCitation[] {
  const citations = closedArray(value, maximum).map(parseCloseoutCitation);
  if (citations.length === 0
    || new Set(citations.flatMap(item => [item.citation_id, item.source_id])).size !== citations.length * 2) {
    return invalidCloseout();
  }
  return citations;
}
function verificationPayload(value: CloseoutVerification): Omit<CloseoutVerification, "signature"> {
  return {
    schema_version: value.schema_version,
    evidence_id: value.evidence_id,
    verifier_id: value.verifier_id,
    verdict: value.verdict,
    machine_outcome: value.machine_outcome,
    artifact_id: value.artifact_id,
    artifact_digest: value.artifact_digest,
    completion_evidence_id: value.completion_evidence_id,
    completion_evidence_digest: value.completion_evidence_digest,
    observed_at: value.observed_at,
    verified_at: value.verified_at,
    key_id: value.key_id,
    public_key_spki: value.public_key_spki,
    public_key_fingerprint: value.public_key_fingerprint,
    canonical_digest: value.canonical_digest,
  };
}
function verificationCore(value: CloseoutVerification): Omit<CloseoutVerification, "canonical_digest" | "signature"> {
  return {
    schema_version: value.schema_version,
    evidence_id: value.evidence_id,
    verifier_id: value.verifier_id,
    verdict: value.verdict,
    machine_outcome: value.machine_outcome,
    artifact_id: value.artifact_id,
    artifact_digest: value.artifact_digest,
    completion_evidence_id: value.completion_evidence_id,
    completion_evidence_digest: value.completion_evidence_digest,
    observed_at: value.observed_at,
    verified_at: value.verified_at,
    key_id: value.key_id,
    public_key_spki: value.public_key_spki,
    public_key_fingerprint: value.public_key_fingerprint,
  };
}
export function parseCloseoutVerification(
  value: unknown,
  trusted: TrustedCloseoutVerifier,
): CloseoutVerification {
  const input = closedObject(value, [
    "schema_version", "evidence_id", "verifier_id", "verdict", "machine_outcome", "artifact_id",
    "artifact_digest", "completion_evidence_id", "completion_evidence_digest", "observed_at", "verified_at",
    "key_id", "public_key_spki", "public_key_fingerprint", "canonical_digest", "signature",
  ]);
  if (input["schema_version"] !== 1) return invalidCloseout();
  const envelope = parseCloseoutEnvelope({
    schema_version: 1,
    algorithm: "Ed25519",
    key_id: input["key_id"],
    public_key_spki: input["public_key_spki"],
    public_key_fingerprint: input["public_key_fingerprint"],
    signature: input["signature"],
  });
  const parsed: CloseoutVerification = {
    schema_version: 1,
    evidence_id: closeoutText(input["evidence_id"]),
    verifier_id: closeoutText(input["verifier_id"]),
    verdict: closeoutMember(input["verdict"], ["passed", "failed", "uncertain"] as const),
    machine_outcome: closeoutMember(input["machine_outcome"], ["succeeded", "failed", "unknown"] as const),
    artifact_id: closeoutText(input["artifact_id"]),
    artifact_digest: closeoutDigest(input["artifact_digest"]),
    completion_evidence_id: closeoutText(input["completion_evidence_id"]),
    completion_evidence_digest: closeoutDigest(input["completion_evidence_digest"]),
    observed_at: closeoutInstant(input["observed_at"]),
    verified_at: closeoutInstant(input["verified_at"]),
    key_id: envelope.key_id,
    public_key_spki: envelope.public_key_spki,
    public_key_fingerprint: envelope.public_key_fingerprint,
    canonical_digest: closeoutDigest(input["canonical_digest"]),
    signature: envelope.signature,
  };
  if (parsed.canonical_digest !== closeoutHash(verificationCore(parsed))
    || parsed.verifier_id !== trusted.verifier_id || parsed.key_id !== trusted.key_id
    || parsed.public_key_fingerprint !== trusted.public_key_fingerprint
    || Date.parse(parsed.verified_at) < Date.parse(parsed.observed_at)
    || !verifyCloseoutSignature(
      EVENING_VERIFICATION_DOMAIN,
      verificationPayload(parsed),
      { ...envelope },
      { key_id: parsed.key_id, public_key_spki: parsed.public_key_spki },
    )) return invalidCloseout();
  return parsed;
}
export function parseCloseoutRecord(value: unknown, trusted: TrustedCloseoutVerifier): CloseoutRecord {
  const input = closedObject(value, [
    "item_id", "outcome", "reason", "copy", "citations", "observed_at", "fresh_until", "trust",
    "verification", "record_digest",
  ]);
  const verification = input["verification"] === null ? null : parseCloseoutVerification(input["verification"], trusted);
  const record = {
    item_id: closeoutText(input["item_id"]),
    outcome: closeoutMember(input["outcome"], ["completed", "open", "failed", "worker_done"] as const),
    reason: input["reason"] === null ? null : closeoutText(input["reason"]),
    copy: closeoutText(input["copy"], 4_096),
    citations: parseCloseoutCitations(input["citations"]),
    observed_at: closeoutInstant(input["observed_at"]),
    fresh_until: closeoutInstant(input["fresh_until"]),
    trust: closeoutMember(input["trust"], ["trusted", "untrusted", "conflicting"] as const),
    verification,
  };
  const recordDigest = closeoutDigest(input["record_digest"]);
  if (closeoutHash(record) !== recordDigest || Date.parse(record.fresh_until) <= Date.parse(record.observed_at)
    || (record.outcome !== "completed" && record.reason === null)) return invalidCloseout();
  if (verification !== null && (!record.citations.some(item => item.evidence_id === verification.completion_evidence_id)
    || verification.observed_at !== record.observed_at)) return invalidCloseout();
  return { ...record, record_digest: recordDigest };
}
export function parseCloseoutDecision(value: unknown): CloseoutDecision {
  const input = closedObject(value, ["decision_id", "state", "copy", "citations"]);
  return {
    decision_id: closeoutText(input["decision_id"]),
    state: closeoutMember(input["state"], ["made", "owner_required"] as const),
    copy: closeoutText(input["copy"], 4_096),
    citations: parseCloseoutCitations(input["citations"]),
  };
}
export function parseCloseoutCandidate(value: unknown): CloseoutMemoryCandidate {
  const input = closedObject(value, ["candidate_id", "verification_evidence_id", "citations"]);
  return {
    candidate_id: closeoutText(input["candidate_id"]),
    verification_evidence_id: closeoutText(input["verification_evidence_id"]),
    citations: parseCloseoutCitations(input["citations"]),
  };
}
export function parseCloseoutPriority(value: unknown): CloseoutPriority {
  const input = closedObject(value, [
    "owner_safety_gate", "customer_impact", "deadline_bucket", "dependency_blocking",
    "irreversible_risk", "effort_cost", "stable_identity",
  ]);
  return {
    owner_safety_gate: closeoutMember(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    customer_impact: closeoutMember(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline_bucket: closeoutMember(input["deadline_bucket"], PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    dependency_blocking: closeoutMember(input["dependency_blocking"], PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    irreversible_risk: closeoutMember(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: closeoutMember(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    stable_identity: closeoutText(input["stable_identity"]),
  };
}
export function parseCloseoutAction(value: unknown): CloseoutTomorrowAction {
  const input = closedObject(value, [
    "action_id", "disposition", "priority", "observed_at", "fresh_until", "trust", "actionable", "citations",
  ]);
  return {
    action_id: closeoutText(input["action_id"]),
    disposition: closeoutMember(input["disposition"], ["executable", "delegated"] as const),
    priority: parseCloseoutPriority(input["priority"]),
    observed_at: closeoutInstant(input["observed_at"]),
    fresh_until: closeoutInstant(input["fresh_until"]),
    trust: closeoutMember(input["trust"], ["trusted", "untrusted"] as const),
    actionable: closeoutBoolean(input["actionable"]),
    citations: parseCloseoutCitations(input["citations"]),
  };
}
export function parseCloseoutRisk(value: unknown): CloseoutRisk {
  const input = closedObject(value, ["risk_id", "copy", "citations"]);
  return {
    risk_id: closeoutText(input["risk_id"]),
    copy: closeoutText(input["copy"], 4_096),
    citations: parseCloseoutCitations(input["citations"]),
  };
}
