import {
  closedArray,
  closedObject,
  closeoutDigest,
  closeoutInstant,
  closeoutInteger,
  closeoutMember,
  closeoutText,
  invalidCloseout,
} from "./evening-closeout-parse-values.js";
import {
  parseCloseoutAction,
  parseCloseoutCandidate,
  parseCloseoutDecision,
  parseCloseoutRecord,
  parseCloseoutRisk,
} from "./evening-closeout-sections.js";
import type {
  EveningCloseoutInput,
  EveningCloseoutLimits,
  TrustedCloseoutVerifier,
} from "./evening-closeout-types.js";

export const DEFAULT_EVENING_CLOSEOUT_LIMITS: EveningCloseoutLimits = {
  max_completions: 32,
  max_open: 32,
  max_decisions: 32,
  max_risks: 32,
  max_candidates: 32,
  max_sources: 64,
  max_citations: 64,
  max_evidence: 64,
  max_copy_bytes: 256,
  max_total_bytes: 65_536,
};
export function parseEveningCloseoutLimits(value: unknown): EveningCloseoutLimits {
  if (value === null) return DEFAULT_EVENING_CLOSEOUT_LIMITS;
  const input = closedObject(value, [
    "max_completions", "max_open", "max_decisions", "max_risks", "max_candidates",
    "max_sources", "max_citations", "max_evidence", "max_copy_bytes", "max_total_bytes",
  ]);
  return {
    max_completions: closeoutInteger(input["max_completions"], 0, 64),
    max_open: closeoutInteger(input["max_open"], 0, 64),
    max_decisions: closeoutInteger(input["max_decisions"], 0, 64),
    max_risks: closeoutInteger(input["max_risks"], 0, 64),
    max_candidates: closeoutInteger(input["max_candidates"], 0, 64),
    max_sources: closeoutInteger(input["max_sources"], 1, 128),
    max_citations: closeoutInteger(input["max_citations"], 1, 128),
    max_evidence: closeoutInteger(input["max_evidence"], 1, 128),
    max_copy_bytes: closeoutInteger(input["max_copy_bytes"], 1, 1_024),
    max_total_bytes: closeoutInteger(input["max_total_bytes"], 2_048, 131_072),
  };
}
function trustedVerifier(value: unknown): TrustedCloseoutVerifier {
  const input = closedObject(value, ["verifier_id", "key_id", "public_key_fingerprint"]);
  return {
    verifier_id: closeoutText(input["verifier_id"]),
    key_id: closeoutText(input["key_id"], 64),
    public_key_fingerprint: closeoutDigest(input["public_key_fingerprint"]),
  };
}
function assertGlobalIdentity(input: EveningCloseoutInput): void {
  const entityIds = [
    ...input.records.map(value => value.item_id),
    ...input.decisions.map(value => value.decision_id),
    ...input.memory_candidates.map(value => value.candidate_id),
    ...input.tomorrow_actions.map(value => value.action_id),
    ...input.risks.map(value => value.risk_id),
  ];
  const citations = [
    ...input.records.flatMap(value => value.citations),
    ...input.decisions.flatMap(value => value.citations),
    ...input.memory_candidates.flatMap(value => value.citations),
    ...input.tomorrow_actions.flatMap(value => value.citations),
    ...input.risks.flatMap(value => value.citations),
  ];
  const verification = input.records.flatMap(value => value.verification === null ? [] : [value.verification]);
  const evidenceDefinitions = [
    ...input.records.map(value => value.record_digest),
    ...verification.flatMap(value => [
      value.evidence_id,
      value.artifact_id,
      value.completion_evidence_id,
      value.artifact_digest,
      value.completion_evidence_digest,
      value.canonical_digest,
    ]),
  ];
  if (new Set(entityIds).size !== entityIds.length
    || new Set(citations.map(value => value.citation_id)).size !== citations.length
    || new Set(citations.map(value => value.source_id)).size !== citations.length
    || new Set(evidenceDefinitions).size !== evidenceDefinitions.length) return invalidCloseout();
  const passedEvidence = new Set(verification
    .filter(value => value.verdict === "passed" && value.machine_outcome === "succeeded")
    .map(value => value.evidence_id));
  if (input.memory_candidates.some(candidate => !passedEvidence.has(candidate.verification_evidence_id)
    || !candidate.citations.some(citation => citation.evidence_id === candidate.verification_evidence_id))) {
    return invalidCloseout();
  }
}
export function parseEveningCloseoutInput(value: unknown): EveningCloseoutInput {
  const input = closedObject(value, [
    "schema_version", "run_id", "correlation_id", "local_date", "generated_at", "source_readiness",
    "source_omissions", "trusted_verifier", "records", "decisions", "memory_candidates",
    "tomorrow_actions", "risks", "limits",
  ]);
  if (input["schema_version"] !== 1) return invalidCloseout();
  const verifier = trustedVerifier(input["trusted_verifier"]);
  const result: EveningCloseoutInput = {
    schema_version: 1,
    run_id: closeoutText(input["run_id"]),
    correlation_id: closeoutText(input["correlation_id"]),
    local_date: closeoutText(input["local_date"], 10),
    generated_at: closeoutInstant(input["generated_at"]),
    source_readiness: closeoutMember(input["source_readiness"], ["ready", "degraded", "no_data"] as const),
    source_omissions: closedArray(input["source_omissions"], 64).map(value => closeoutText(value)),
    trusted_verifier: verifier,
    records: closedArray(input["records"], 256).map(value => parseCloseoutRecord(value, verifier)),
    decisions: closedArray(input["decisions"], 256).map(parseCloseoutDecision),
    memory_candidates: closedArray(input["memory_candidates"], 256).map(parseCloseoutCandidate),
    tomorrow_actions: closedArray(input["tomorrow_actions"], 256).map(parseCloseoutAction),
    risks: closedArray(input["risks"], 256).map(parseCloseoutRisk),
    limits: parseEveningCloseoutLimits(input["limits"]),
  };
  const count = result.records.length + result.decisions.length + result.memory_candidates.length
    + result.tomorrow_actions.length + result.risks.length;
  if (!/^\d{4}-\d\d-\d\d$/.test(result.local_date)
    || (result.source_readiness === "no_data" && count > 0)
    || (result.source_readiness === "degraded" && result.source_omissions.length === 0)) return invalidCloseout();
  if (result.records.some(record => record.verification !== null
    && Date.parse(record.verification.verified_at) > Date.parse(result.generated_at))) return invalidCloseout();
  assertGlobalIdentity(result);
  return result;
}
