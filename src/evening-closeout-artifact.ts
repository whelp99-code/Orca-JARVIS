import { canonicalize } from "./canonical.js";
import {
  closeoutHash,
  EVENING_CLOSEOUT_DOMAIN,
  parseCloseoutEnvelope,
  verifyCloseoutSignature,
} from "./evening-closeout-crypto.js";
import { parseEveningCloseoutLimits } from "./evening-closeout-input.js";
import {
  closedArray,
  closedObject,
  closeoutDigest,
  closeoutInstant,
  closeoutInteger,
  closeoutMember,
  closeoutText,
} from "./evening-closeout-parse-values.js";
import {
  parseCloseoutAction,
  parseCloseoutCandidate,
  parseCloseoutCitations,
  parseCloseoutDecision,
  parseCloseoutRecord,
  parseCloseoutRisk,
} from "./evening-closeout-sections.js";
import type {
  CloseoutOmission,
  CloseoutOpenFact,
  CloseoutRecord,
  EveningCloseoutArtifact,
  TrustedCloseoutKey,
} from "./evening-closeout-types.js";
import { EveningCloseoutError } from "./evening-closeout-types.js";

function trustedRecord(value: unknown): CloseoutRecord {
  const record = closedObject(value, [
    "item_id", "outcome", "reason", "copy", "citations", "observed_at", "fresh_until", "trust",
    "verification", "record_digest",
  ]);
  const verification = closedObject(record["verification"], [
    "schema_version", "evidence_id", "verifier_id", "verdict", "machine_outcome", "artifact_id",
    "artifact_digest", "completion_evidence_id", "completion_evidence_digest", "observed_at", "verified_at",
    "key_id", "public_key_spki", "public_key_fingerprint", "canonical_digest", "signature",
  ]);
  return parseCloseoutRecord(value, {
    verifier_id: closeoutText(verification["verifier_id"]),
    key_id: closeoutText(verification["key_id"]),
    public_key_fingerprint: closeoutDigest(verification["public_key_fingerprint"]),
  });
}
function openFact(value: unknown): CloseoutOpenFact {
  const input = closedObject(value, [
    "item_id", "state", "reason", "copy", "citations", "record_digest",
  ]);
  return {
    item_id: closeoutText(input["item_id"]),
    state: closeoutMember(input["state"], ["open", "failed", "uncertain"] as const),
    reason: closeoutText(input["reason"]),
    copy: closeoutText(input["copy"], 1_024),
    citations: parseCloseoutCitations(input["citations"]),
    record_digest: closeoutDigest(input["record_digest"]),
  };
}
function omission(value: unknown): CloseoutOmission {
  const input = closedObject(value, ["reason", "count"]);
  return {
    reason: closeoutMember(input["reason"], [
      "completion_cap", "open_cap", "decision_cap", "risk_cap", "action_cap", "candidate_cap",
      "source_cap", "citation_cap", "evidence_cap", "copy_truncated",
    ] as const),
    count: closeoutInteger(input["count"], 1, 256),
  };
}
function artifactCore(value: EveningCloseoutArtifact) {
  return {
    schema_version: value.schema_version,
    run_id: value.run_id,
    correlation_id: value.correlation_id,
    local_date: value.local_date,
    generated_at: value.generated_at,
    source_readiness: value.source_readiness,
    source_omissions: value.source_omissions,
    verified_completions: value.verified_completions,
    open_or_failed: value.open_or_failed,
    decisions_made: value.decisions_made,
    owner_decisions_required: value.owner_decisions_required,
    eligible_memory_candidate_ids: value.eligible_memory_candidate_ids,
    memory_candidate_support: value.memory_candidate_support,
    tomorrow_first_action: value.tomorrow_first_action,
    unresolved_risks: value.unresolved_risks,
    omissions: value.omissions,
    omitted_count: value.omitted_count,
    limits: value.limits,
  };
}
function unsignedArtifact(value: EveningCloseoutArtifact) {
  const envelope = {
    schema_version: value.envelope.schema_version,
    algorithm: value.envelope.algorithm,
    key_id: value.envelope.key_id,
    public_key_spki: value.envelope.public_key_spki,
    public_key_fingerprint: value.envelope.public_key_fingerprint,
  };
  return {
    ...artifactCore(value),
    artifact_id: value.artifact_id,
    canonical_digest: value.canonical_digest,
    envelope,
  };
}
function assertArtifactBounds(value: EveningCloseoutArtifact): void {
  const decisions = value.decisions_made.length + value.owner_decisions_required.length;
  const cited = [
    ...value.verified_completions,
    ...value.open_or_failed,
    ...value.decisions_made,
    ...value.owner_decisions_required,
    ...value.memory_candidate_support,
    ...value.unresolved_risks,
    ...(value.tomorrow_first_action === "none" ? [] : [value.tomorrow_first_action]),
  ];
  if (value.verified_completions.length > value.limits.max_completions
    || value.open_or_failed.length > value.limits.max_open || decisions > value.limits.max_decisions
    || value.unresolved_risks.length > value.limits.max_risks
    || value.eligible_memory_candidate_ids.length > value.limits.max_candidates
    || cited.some(item => item.citations.length > value.limits.max_citations
      || new Set(item.citations.map(citation => citation.source_id)).size > value.limits.max_sources)
    || cited.some(item => "copy" in item
      && Buffer.byteLength(item.copy, "utf8") > value.limits.max_copy_bytes)
    || Buffer.byteLength(canonicalize(value), "utf8") > value.limits.max_total_bytes) {
    throw new EveningCloseoutError("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
  }
}
function assertArtifactIdentities(value: EveningCloseoutArtifact): void {
  const entityIds = [
    ...value.verified_completions.map(item => item.item_id),
    ...value.open_or_failed.map(item => item.item_id),
    ...value.decisions_made.map(item => item.decision_id),
    ...value.owner_decisions_required.map(item => item.decision_id),
    ...value.eligible_memory_candidate_ids,
    ...(value.tomorrow_first_action === "none" ? [] : [value.tomorrow_first_action.action_id]),
    ...value.unresolved_risks.map(item => item.risk_id),
  ];
  const citations = [
    ...value.verified_completions.flatMap(item => item.citations),
    ...value.open_or_failed.flatMap(item => item.citations),
    ...value.decisions_made.flatMap(item => item.citations),
    ...value.owner_decisions_required.flatMap(item => item.citations),
    ...value.memory_candidate_support.flatMap(item => item.citations),
    ...(value.tomorrow_first_action === "none" ? [] : value.tomorrow_first_action.citations),
    ...value.unresolved_risks.flatMap(item => item.citations),
  ];
  const evidence = value.verified_completions.flatMap(item => {
    const verification = item.verification;
    return verification === null ? [] : [verification];
  });
  const evidenceDefinitions = [
    ...value.verified_completions.map(item => item.record_digest),
    ...value.open_or_failed.map(item => item.record_digest),
    ...evidence.flatMap(item => [
      item.evidence_id, item.artifact_id, item.completion_evidence_id,
      item.artifact_digest, item.completion_evidence_digest, item.canonical_digest,
    ]),
  ];
  const passed = new Set(evidence.map(item => item.evidence_id));
  const supportIds = value.memory_candidate_support.map(item => item.candidate_id);
  if (new Set(entityIds).size !== entityIds.length
    || new Set(citations.map(item => item.citation_id)).size !== citations.length
    || new Set(citations.map(item => item.source_id)).size !== citations.length
    || new Set(evidenceDefinitions).size !== evidenceDefinitions.length
    || supportIds.join("\0") !== value.eligible_memory_candidate_ids.join("\0")
    || value.memory_candidate_support.some(item => !passed.has(item.verification_evidence_id)
      || !item.citations.some(citation => citation.evidence_id === item.verification_evidence_id))) {
    throw new EveningCloseoutError("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
  }
}
export function verifyEveningCloseoutArtifact(
  value: unknown,
  trusted: TrustedCloseoutKey,
): EveningCloseoutArtifact {
  try {
    const input = closedObject(value, [
      "schema_version", "artifact_id", "run_id", "correlation_id", "local_date", "generated_at",
      "source_readiness", "source_omissions", "verified_completions", "open_or_failed", "decisions_made",
      "owner_decisions_required", "eligible_memory_candidate_ids", "memory_candidate_support",
      "tomorrow_first_action", "unresolved_risks", "omissions", "omitted_count", "limits", "canonical_digest", "envelope",
    ]);
    if (input["schema_version"] !== 1) throw new EveningCloseoutError("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    const artifact: EveningCloseoutArtifact = {
      schema_version: 1,
      artifact_id: closeoutText(input["artifact_id"]),
      run_id: closeoutText(input["run_id"]),
      correlation_id: closeoutText(input["correlation_id"]),
      local_date: closeoutText(input["local_date"], 10),
      generated_at: closeoutInstant(input["generated_at"]),
      source_readiness: closeoutMember(input["source_readiness"], ["ready", "degraded", "no_data"] as const),
      source_omissions: closedArray(input["source_omissions"], 64).map(item => closeoutText(item)),
      verified_completions: closedArray(input["verified_completions"], 64).map(trustedRecord),
      open_or_failed: closedArray(input["open_or_failed"], 64).map(openFact),
      decisions_made: closedArray(input["decisions_made"], 64).map(parseCloseoutDecision),
      owner_decisions_required: closedArray(input["owner_decisions_required"], 64).map(parseCloseoutDecision),
      eligible_memory_candidate_ids: closedArray(input["eligible_memory_candidate_ids"], 64)
        .map(item => closeoutText(item)),
      memory_candidate_support: closedArray(input["memory_candidate_support"], 64)
        .map(parseCloseoutCandidate),
      tomorrow_first_action: input["tomorrow_first_action"] === "none"
        ? "none" : parseCloseoutAction(input["tomorrow_first_action"]),
      unresolved_risks: closedArray(input["unresolved_risks"], 64).map(parseCloseoutRisk),
      omissions: closedArray(input["omissions"], 10).map(omission),
      omitted_count: closeoutInteger(input["omitted_count"], 0, 2_560),
      limits: parseEveningCloseoutLimits(input["limits"]),
      canonical_digest: closeoutDigest(input["canonical_digest"]),
      envelope: parseCloseoutEnvelope(input["envelope"]),
    };
    const expected = closeoutHash(artifactCore(artifact));
    if (artifact.canonical_digest !== expected
      || artifact.artifact_id !== `evening-closeout:v1:${expected.slice(7)}`
      || artifact.omitted_count !== artifact.omissions.reduce((sum, item) => sum + item.count, 0)
      || !verifyCloseoutSignature(
        EVENING_CLOSEOUT_DOMAIN,
        unsignedArtifact(artifact),
        artifact.envelope,
        trusted,
      )) throw new EveningCloseoutError("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    assertArtifactIdentities(artifact);
    assertArtifactBounds(artifact);
    return artifact;
  } catch (error) {
    if (error instanceof EveningCloseoutError) {
      throw new EveningCloseoutError("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    }
    throw error;
  }
}
export function verifyEveningCloseout(value: unknown, trusted: TrustedCloseoutKey): boolean {
  try {
    verifyEveningCloseoutArtifact(value, trusted);
    return true;
  } catch (error) {
    if (error instanceof EveningCloseoutError) return false;
    throw error;
  }
}
