import { createHash, sign, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CloseoutCitation, CloseoutSigner, CloseoutVerifier, EveningCloseoutArtifact, EveningCloseoutInput } from "./evening-closeout-types.js";
import { EveningCloseoutError } from "./evening-closeout-types.js";
import { containsPrivateMetadata } from "./private-text.js";

export const EVENING_CLOSEOUT_DOMAIN = "orca-jarvis/evening-closeout/v1\0";
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = <Value>(values: readonly Value[], identity: (value: Value) => string): readonly Value[] =>
  [...values].sort((left, right) => compare(identity(left), identity(right)));
function copy(value: string, maximum: number): string { let result = ""; for (const character of value) {
  if (Buffer.byteLength(`${result}${character}`) > maximum) break; result += character; } return result; }
function citations(values: readonly CloseoutCitation[], maximum: number): readonly CloseoutCitation[] {
  return sorted(values, value => `${value.source_id}\0${value.evidence_id}`).slice(0, maximum);
}
function signaturePayload(artifact: EveningCloseoutArtifact): Omit<EveningCloseoutArtifact, "signature"> {
  return {
    schema_version: artifact.schema_version, artifact_id: artifact.artifact_id, run_id: artifact.run_id,
    correlation_id: artifact.correlation_id, local_date: artifact.local_date, generated_at: artifact.generated_at,
    source_readiness: artifact.source_readiness, source_omissions: artifact.source_omissions,
    verified_completions: artifact.verified_completions, open_or_failed: artifact.open_or_failed,
    decisions_made: artifact.decisions_made, owner_decisions_required: artifact.owner_decisions_required,
    eligible_memory_candidate_ids: artifact.eligible_memory_candidate_ids,
    tomorrow_first_action: artifact.tomorrow_first_action, unresolved_risks: artifact.unresolved_risks,
    limits: artifact.limits, canonical_digest: artifact.canonical_digest, key_id: artifact.key_id,
    algorithm: artifact.algorithm,
  };
}
function digestCore(artifact: EveningCloseoutArtifact): string {
  return hash({ schema_version: artifact.schema_version, run_id: artifact.run_id, correlation_id: artifact.correlation_id,
    local_date: artifact.local_date, generated_at: artifact.generated_at, source_readiness: artifact.source_readiness,
    source_omissions: artifact.source_omissions, verified_completions: artifact.verified_completions,
    open_or_failed: artifact.open_or_failed, decisions_made: artifact.decisions_made,
    owner_decisions_required: artifact.owner_decisions_required,
    eligible_memory_candidate_ids: artifact.eligible_memory_candidate_ids,
    tomorrow_first_action: artifact.tomorrow_first_action, unresolved_risks: artifact.unresolved_risks,
    limits: artifact.limits });
}
export function generateEveningCloseout(input: EveningCloseoutInput, signer: CloseoutSigner): EveningCloseoutArtifact {
  const generatedAt = signer.clock();
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== input.generated_at) {
    throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
  }
  const itemLimit = input.limits.max_items; const evidenceLimit = input.limits.max_evidence_per_item;
  const completions = sorted(input.records.filter(record => record.outcome === "completed" && record.trust === "trusted"
    && record.verification.outcome === "passed" && record.verification.evidence_id !== null
    && record.verification.evidence_digest !== null && Date.parse(record.fresh_until) > Date.parse(input.generated_at)), value => value.item_id)
    .slice(0, itemLimit).map(value => ({ item_id: value.item_id, copy: copy(value.copy, input.limits.max_copy_bytes),
      citations: citations(value.citations, evidenceLimit), verification_evidence_id: value.verification.evidence_id ?? "" }));
  const completionIds = new Set(completions.map(value => value.item_id));
  const open = sorted(input.records.filter(value => !completionIds.has(value.item_id)), value => value.item_id).slice(0, itemLimit)
    .map(value => ({ item_id: value.item_id,
      state: value.outcome === "failed" ? "failed" as const
        : value.outcome === "open" ? "open" as const : "uncertain" as const,
      reason: value.reason ?? (value.verification.outcome === "failed" ? "VERIFICATION_FAILED"
        : value.trust === "conflicting" ? "EVIDENCE_CONFLICTING"
        : value.trust === "untrusted" ? "EVIDENCE_UNTRUSTED"
        : Date.parse(value.fresh_until) <= Date.parse(input.generated_at) ? "EVIDENCE_STALE" : "EVIDENCE_MISSING"),
      copy: copy(value.copy, input.limits.max_copy_bytes), citations: citations(value.citations, evidenceLimit) }));
  const decisions = sorted(input.decisions, value => value.decision_id).slice(0, itemLimit).map(value => ({ ...value,
    copy: copy(value.copy, input.limits.max_copy_bytes), citations: citations(value.citations, evidenceLimit) }));
  const risks = sorted(input.risks, value => value.risk_id).slice(0, itemLimit).map(value => ({ ...value,
    copy: copy(value.copy, input.limits.max_copy_bytes), citations: citations(value.citations, evidenceLimit) }));
  const first = sorted(input.tomorrow_actions, value => `${String(value.rank).padStart(3, "0")}\0${value.action_id}`)[0];
  const core = { schema_version: 1 as const, run_id: input.run_id, correlation_id: input.correlation_id, local_date: input.local_date,
    generated_at: input.generated_at, source_readiness: input.source_readiness, source_omissions: [...new Set(input.source_omissions)].sort(compare),
    verified_completions: completions, open_or_failed: open, decisions_made: decisions.filter(value => value.state === "made"),
    owner_decisions_required: decisions.filter(value => value.state === "owner_required"),
    eligible_memory_candidate_ids: sorted(input.memory_candidates.filter(value => value.eligible), value => value.candidate_id)
      .slice(0, input.limits.max_candidates).map(value => value.candidate_id),
    tomorrow_first_action: first === undefined ? "none" as const : { action_id: first.action_id, citations: citations(first.citations, evidenceLimit) },
    unresolved_risks: risks, limits: input.limits };
  const canonicalDigest = hash(core); const artifactId = `evening-closeout:v1:${canonicalDigest.slice(7)}`;
  const payload = { ...core, artifact_id: artifactId, canonical_digest: canonicalDigest, key_id: signer.key_id, algorithm: "Ed25519" as const };
  const signature = sign(null, Buffer.from(EVENING_CLOSEOUT_DOMAIN + canonicalize(payload)), signer.private_key).toString("base64url");
  const artifact = { ...payload, signature };
  if (Buffer.byteLength(canonicalize(artifact)) > input.limits.max_total_bytes) throw new EveningCloseoutError("EVENING_CLOSEOUT_INPUT_INVALID");
  return artifact;
}
function validStrings(value: unknown): boolean {
  if (typeof value === "string") return value === value.normalize("NFC") && !containsPrivateMetadata(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(validStrings);
  if (typeof value !== "object") return false;
  try { if (Object.getPrototypeOf(value) !== Object.prototype) return false; const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every(key => typeof key === "string" && descriptors[key]?.get === undefined
      && descriptors[key]?.set === undefined && validStrings(descriptors[key]?.value)); } catch { return false; }
}
export function verifyEveningCloseout(artifact: EveningCloseoutArtifact, verifier: CloseoutVerifier): boolean {
  try {
    if (!validStrings(artifact) || artifact.schema_version !== 1 || artifact.algorithm !== "Ed25519" || artifact.key_id !== verifier.key_id
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(artifact.generated_at)
      || new Date(Date.parse(artifact.generated_at)).toISOString() !== artifact.generated_at) return false;
    const expected = digestCore(artifact);
    if (expected !== artifact.canonical_digest || artifact.artifact_id !== `evening-closeout:v1:${expected.slice(7)}`) return false;
    return verify(null, Buffer.from(EVENING_CLOSEOUT_DOMAIN + canonicalize(signaturePayload(artifact))), verifier.public_key,
      Buffer.from(artifact.signature, "base64url"));
  } catch { return false; }
}
