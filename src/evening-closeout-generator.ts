import { canonicalize } from "./canonical.js";
import {
  closeoutHash,
  closeoutSigningBytes,
  EVENING_CLOSEOUT_DOMAIN,
  parseCloseoutSigningIdentity,
  verifyCloseoutSignature,
} from "./evening-closeout-crypto.js";
import { compareCloseoutAction } from "./evening-closeout-priority.js";
import { createProvenanceFilter } from "./evening-closeout-provenance.js";
import type {
  CloseoutCitation,
  CloseoutOmission,
  CloseoutOmissionReason,
  CloseoutOpenFact,
  CloseoutRecord,
  CloseoutSigningHandle,
  EveningCloseoutArtifact,
  EveningCloseoutInput,
} from "./evening-closeout-types.js";
import { EveningCloseoutError } from "./evening-closeout-types.js";

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = <Value>(values: readonly Value[], identity: (value: Value) => string): readonly Value[] =>
  [...values].sort((left, right) => compareText(identity(left), identity(right)));
const OMISSION_ORDER = [
  "completion_cap", "open_cap", "decision_cap", "risk_cap", "action_cap", "candidate_cap",
  "source_cap", "citation_cap", "evidence_cap", "copy_truncated",
] as const;
function truncateCopy(value: string, maximum: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}`, "utf8") > maximum) break;
    result += character;
  }
  return result;
}
function increment(counts: Map<CloseoutOmissionReason, number>, reason: CloseoutOmissionReason, count = 1): void {
  if (count > 0) counts.set(reason, (counts.get(reason) ?? 0) + count);
}
function omissions(counts: ReadonlyMap<CloseoutOmissionReason, number>): readonly CloseoutOmission[] {
  return OMISSION_ORDER.flatMap(reason => {
    const count = counts.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  });
}
function citationsWithin(values: readonly CloseoutCitation[], input: EveningCloseoutInput): boolean {
  if (values.length > input.limits.max_citations) return false;
  return new Set(values.map(value => value.source_id)).size <= input.limits.max_sources;
}
function generatedRecord(value: CloseoutRecord, copy: string): CloseoutRecord {
  const core = {
    item_id: value.item_id,
    outcome: value.outcome,
    reason: value.reason,
    copy,
    citations: value.citations,
    observed_at: value.observed_at,
    fresh_until: value.fresh_until,
    trust: value.trust,
    verification: value.verification,
  };
  return { ...core, record_digest: closeoutHash(core) };
}
function boundedRecords(
  values: readonly CloseoutRecord[],
  input: EveningCloseoutInput,
  counts: Map<CloseoutOmissionReason, number>,
): readonly CloseoutRecord[] {
  return values.flatMap(value => {
    if (!citationsWithin(value.citations, input)) {
      increment(counts, value.citations.length > input.limits.max_citations ? "citation_cap" : "source_cap");
      return [];
    }
    if (value.verification !== null && input.limits.max_evidence < 3) {
      increment(counts, "evidence_cap");
      return [];
    }
    const boundedCopy = truncateCopy(value.copy, input.limits.max_copy_bytes);
    if (boundedCopy !== value.copy) increment(counts, "copy_truncated");
    return [generatedRecord(value, boundedCopy)];
  });
}
function completionEligible(value: CloseoutRecord, generatedAt: string): boolean {
  const verification = value.verification;
  return value.outcome === "completed" && value.trust === "trusted"
    && Date.parse(value.fresh_until) > Date.parse(generatedAt) && verification !== null
    && verification.verdict === "passed" && verification.machine_outcome === "succeeded"
    && value.citations.some(citation => citation.evidence_id === verification.completion_evidence_id);
}
function openFact(value: CloseoutRecord, generatedAt: string): CloseoutOpenFact {
  const verification = value.verification;
  const reason = value.reason ?? (verification?.verdict === "failed" ? "VERIFICATION_FAILED"
    : verification?.verdict === "uncertain" ? "VERIFICATION_UNCERTAIN"
    : value.trust === "conflicting" ? "EVIDENCE_CONFLICTING"
    : value.trust === "untrusted" ? "EVIDENCE_UNTRUSTED"
    : Date.parse(value.fresh_until) <= Date.parse(generatedAt) ? "EVIDENCE_STALE" : "EVIDENCE_MISSING");
  return {
    item_id: value.item_id,
    state: value.outcome === "failed" ? "failed" : value.outcome === "open" ? "open" : "uncertain",
    reason,
    copy: value.copy,
    citations: value.citations,
    record_digest: value.record_digest,
  };
}
type Core = Omit<EveningCloseoutArtifact, "artifact_id" | "canonical_digest" | "envelope">;
function signedArtifact(core: Core, handle: CloseoutSigningHandle): EveningCloseoutArtifact {
  const identity = parseCloseoutSigningIdentity(handle.identity);
  const canonicalDigest = closeoutHash(core);
  const artifactId = `evening-closeout:v1:${canonicalDigest.slice(7)}`;
  const unsigned = {
    ...core,
    artifact_id: artifactId,
    canonical_digest: canonicalDigest,
    envelope: identity,
  };
  const signatureBytes = handle.sign(closeoutSigningBytes(EVENING_CLOSEOUT_DOMAIN, unsigned));
  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.byteLength !== 64) {
    throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
  }
  const artifact: EveningCloseoutArtifact = {
    ...core,
    artifact_id: artifactId,
    canonical_digest: canonicalDigest,
    envelope: { ...identity, signature: Buffer.from(signatureBytes).toString("base64url") },
  };
  if (!verifyCloseoutSignature(
    EVENING_CLOSEOUT_DOMAIN,
    unsigned,
    artifact.envelope,
    { key_id: identity.key_id, public_key_spki: identity.public_key_spki },
  )) throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
  return artifact;
}
export function generateEveningCloseout(
  input: EveningCloseoutInput,
  handle: CloseoutSigningHandle,
): EveningCloseoutArtifact {
  const now = handle.clock();
  if (Number.isNaN(now.getTime()) || now.toISOString() !== input.generated_at) {
    throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
  }
  const counts = new Map<CloseoutOmissionReason, number>();
  const records = boundedRecords(sorted(input.records, value => value.item_id), input, counts);
  const completionCandidates = records.filter(value => completionEligible(value, input.generated_at));
  const openCandidates = records.filter(value => !completionEligible(value, input.generated_at));
  increment(counts, "completion_cap", completionCandidates.length - input.limits.max_completions);
  increment(counts, "open_cap", openCandidates.length - input.limits.max_open);
  let completions = completionCandidates.slice(0, input.limits.max_completions);
  let open = openCandidates.slice(0, input.limits.max_open).map(value => openFact(value, input.generated_at));
  const decisions = sorted(input.decisions, value => value.decision_id).flatMap(value => {
    if (!citationsWithin(value.citations, input)) {
      increment(counts, value.citations.length > input.limits.max_citations ? "citation_cap" : "source_cap");
      return [];
    }
    const boundedCopy = truncateCopy(value.copy, input.limits.max_copy_bytes);
    if (boundedCopy !== value.copy) increment(counts, "copy_truncated");
    return [{ ...value, copy: boundedCopy }];
  });
  increment(counts, "decision_cap", decisions.length - input.limits.max_decisions);
  let made = decisions.filter(value => value.state === "made").slice(0, input.limits.max_decisions);
  let owner = decisions.filter(value => value.state === "owner_required")
    .slice(0, Math.max(0, input.limits.max_decisions - made.length));
  const riskCandidates = sorted(input.risks, value => value.risk_id).flatMap(value => {
    if (!citationsWithin(value.citations, input)) {
      increment(counts, value.citations.length > input.limits.max_citations ? "citation_cap" : "source_cap");
      return [];
    }
    const boundedCopy = truncateCopy(value.copy, input.limits.max_copy_bytes);
    if (boundedCopy !== value.copy) increment(counts, "copy_truncated");
    return [{ ...value, copy: boundedCopy }];
  });
  let risks = riskCandidates.slice(0, input.limits.max_risks);
  increment(counts, "risk_cap", riskCandidates.length - risks.length);
  const withinArtifactProvenance = createProvenanceFilter(
    input.limits,
    reason => increment(counts, reason),
  );
  completions = withinArtifactProvenance(completions, value => value.verification === null ? [] : [
    value.verification.evidence_id,
    value.verification.artifact_id,
    value.verification.completion_evidence_id,
  ]);
  open = withinArtifactProvenance(open);
  made = withinArtifactProvenance(made);
  owner = withinArtifactProvenance(owner);
  const completionEvidence = new Set(completions.flatMap(value =>
    value.verification === null ? [] : [value.verification.evidence_id]));
  const candidateCandidates = sorted(input.memory_candidates, value => value.candidate_id)
    .filter(value => citationsWithin(value.citations, input)
      && completionEvidence.has(value.verification_evidence_id));
  let candidateSupport = withinArtifactProvenance(
    candidateCandidates.slice(0, input.limits.max_candidates),
  );
  let candidateIds = candidateSupport.map(value => value.candidate_id);
  increment(counts, "candidate_cap", input.memory_candidates.length - candidateIds.length);
  const eligibleActions = input.tomorrow_actions.filter(value => value.actionable && value.trust === "trusted"
    && citationsWithin(value.citations, input) && Date.parse(value.fresh_until) > now.getTime()
    && Date.parse(value.observed_at) <= now.getTime()).sort(compareCloseoutAction);
  let first = eligibleActions[0] ?? "none" as const;
  if (first !== "none") {
    const selected = withinArtifactProvenance([first]);
    first = selected[0] ?? "none";
  }
  risks = withinArtifactProvenance(risks);
  increment(counts, "action_cap", Math.max(0, eligibleActions.length - 1));
  const buildCore = (): Core => {
    const listed = omissions(counts);
    return {
      schema_version: 1,
      run_id: input.run_id,
      correlation_id: input.correlation_id,
      local_date: input.local_date,
      generated_at: input.generated_at,
      source_readiness: input.source_readiness,
      source_omissions: [...new Set(input.source_omissions)].sort(compareText),
      verified_completions: completions,
      open_or_failed: open,
      decisions_made: made,
      owner_decisions_required: owner,
      eligible_memory_candidate_ids: candidateIds,
      memory_candidate_support: candidateSupport,
      tomorrow_first_action: first,
      unresolved_risks: risks,
      omissions: listed,
      omitted_count: listed.reduce((sum, value) => sum + value.count, 0),
      limits: input.limits,
    };
  };
  let artifact = signedArtifact(buildCore(), handle);
  while (Buffer.byteLength(canonicalize(artifact), "utf8") > input.limits.max_total_bytes) {
    if (risks.length > 0) { risks = risks.slice(0, -1); increment(counts, "risk_cap"); }
    else if (open.length > 0) { open = open.slice(0, -1); increment(counts, "open_cap"); }
    else if (owner.length > 0) { owner = owner.slice(0, -1); increment(counts, "decision_cap"); }
    else if (made.length > 0) { made = made.slice(0, -1); increment(counts, "decision_cap"); }
    else if (completions.length > 0) { completions = completions.slice(0, -1); increment(counts, "completion_cap"); }
    else if (candidateIds.length > 0) {
      candidateIds = candidateIds.slice(0, -1);
      candidateSupport = candidateSupport.slice(0, -1);
      increment(counts, "candidate_cap");
    }
    else if (first !== "none") { first = "none"; increment(counts, "action_cap"); }
    else throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
    artifact = signedArtifact(buildCore(), handle);
  }
  return artifact;
}
