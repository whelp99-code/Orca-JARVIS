import type {
  RecommendationId,
  RecommendationV1,
  Sha256Digest,
  UtcTimestamp,
} from "./personal-contracts.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "./personal-validation.js";
import { persistenceHash } from "./personal-persistence-values.js";
import type { PriorityActionDecision, PriorityEngineResult } from "./priority-engine.js";
import { parsePriorityEngineResult, PriorityResultContractError } from "./priority-result-parser.js";
import {
  deriveRecommendationEvidenceLinks,
  RecommendationEvidenceBindingError,
} from "./recommendation-evidence-binding.js";
import { RecommendationIdentityError, encodeRecommendationProvenance } from "./recommendation-identity.js";
import { projectRecommendations, type RecommendationReadProjection } from "./recommendation-projection.js";
import {
  parseRecommendationActionMaterials,
  parseRecommendationEvidenceLinks,
  RecommendationProvenanceContractError,
  type RecommendationActionMaterial,
  type RecommendationEvidenceLink,
  type RecommendationProvenance,
} from "./recommendation-provenance.js";

export const RECOMMENDATION_ERROR_CODES = [
  "RECOMMENDATION_INPUT_INVALID", "RECOMMENDATION_RANKING_INVALID", "RECOMMENDATION_CONTEXT_NOT_FOUND",
  "RECOMMENDATION_CONTEXT_STALE", "RECOMMENDATION_IDENTITY_CONFLICT", "RECOMMENDATION_EVIDENCE_CONFLICT",
  "RECOMMENDATION_TRANSITION_CONFLICT", "RECOMMENDATION_EXPIRED", "RECOMMENDATION_SUPERSESSION_CONFLICT",
] as const;
export type RecommendationErrorCode = (typeof RECOMMENDATION_ERROR_CODES)[number];
export class RecommendationError extends Error {
  readonly name = "RecommendationError";
  constructor(readonly code: RecommendationErrorCode) { super(code); }
}
export type CreateRecommendationResult = {
  readonly recommendation: RecommendationV1;
  readonly canonical_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
  readonly identity_digest: Sha256Digest;
  readonly provenance_digest: Sha256Digest;
};

type Input = Readonly<Record<string, unknown>>;
function fail(code: RecommendationErrorCode): never { throw new RecommendationError(code); }
function object(value: unknown, keys: readonly string[], code: RecommendationErrorCode): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail(code);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail(code);
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > maximum) return fail("RECOMMENDATION_INPUT_INVALID");
  return value;
}
function instant(value: unknown): UtcTimestamp {
  const parsed = text(value, 32); const milliseconds = Date.parse(parsed);
  function valid(candidate: string): candidate is UtcTimestamp {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate)
      && Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate;
  }
  return valid(parsed) ? parsed : fail("RECOMMENDATION_INPUT_INVALID");
}
function digest(value: unknown): Sha256Digest {
  const parsed = text(value, 71);
  function valid(candidate: string): candidate is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(candidate); }
  return valid(parsed) ? parsed : fail("RECOMMENDATION_INPUT_INVALID");
}
function recommendationId(value: unknown): RecommendationId {
  const parsed = text(value, 64);
  function valid(candidate: string): candidate is RecommendationId {
    return /^rec:pos:v1:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate);
  }
  return valid(parsed) ? parsed : fail("RECOMMENDATION_INPUT_INVALID");
}
function ranking(value: unknown): PriorityEngineResult {
  try { return parsePriorityEngineResult(value); }
  catch (error) { if (error instanceof PriorityResultContractError) return fail("RECOMMENDATION_RANKING_INVALID"); throw error; }
}
function selectedActions(result: PriorityEngineResult): readonly PriorityActionDecision[] {
  const selected = result.actions.filter(action => action.rank !== null);
  if (result.status !== "ranked" || selected.length === 0
    || selected.some((action, index) => action.rank !== index + 1 || action.authority !== "none"
      || action.disposition === "excluded" || action.disposition === "abstained")) return fail("RECOMMENDATION_RANKING_INVALID");
  return selected;
}
function creationProvenanceInputs(value: unknown, links: unknown): {
  readonly materials: readonly RecommendationActionMaterial[];
  readonly evidenceLinks: readonly RecommendationEvidenceLink[];
} {
  try {
    return { materials: parseRecommendationActionMaterials(value), evidenceLinks: parseRecommendationEvidenceLinks(links) };
  } catch (error) {
    if (error instanceof RecommendationProvenanceContractError) return fail("RECOMMENDATION_INPUT_INVALID");
    throw error;
  }
}
function mapPersistenceError(error: unknown): never {
  if (!(error instanceof JarvisError)) throw error;
  switch (error.code) {
    case "PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT": return fail("RECOMMENDATION_IDENTITY_CONFLICT");
    case "PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT": return fail("RECOMMENDATION_EVIDENCE_CONFLICT");
    case "PERSONAL_CONTEXT_EXPIRED": case "PERSONAL_RECOMMENDATION_STALE": return fail("RECOMMENDATION_CONTEXT_STALE");
    case "PERSONAL_RECOMMENDATION_EXPIRED": return fail("RECOMMENDATION_EXPIRED");
    case "PERSONAL_ACTION_STATE_CONFLICT": return fail("RECOMMENDATION_TRANSITION_CONFLICT");
    default: return fail("RECOMMENDATION_INPUT_INVALID");
  }
}

export class Recommendations {
  constructor(private readonly authority: AuthorityDb) {}

  create(value: unknown): CreateRecommendationResult {
    const input = object(value, ["id", "idempotency_key", "correlation_id", "causation_id", "context_id", "context_digest",
      "expires_at", "ranking", "actions", "linux_evidence", "approval_requirement", "confidence_class"], "RECOMMENDATION_INPUT_INVALID");
    const parsedRanking = ranking(input["ranking"]); const selected = selectedActions(parsedRanking);
    const provenanceInputs = creationProvenanceInputs(input["actions"], input["linux_evidence"]);
    const supplied = provenanceInputs.materials;
    if (selected.length !== supplied.length
      || new Set(supplied.map(action => action.action_id)).size !== supplied.length) {
      return fail("RECOMMENDATION_RANKING_INVALID");
    }
    const byId = new Map(supplied.map(action => [action.action_id, action]));
    const bound = selected.map((action, index) => {
      const material = byId.get(action.action_id);
      if (material === undefined || action.rank !== index + 1) return fail("RECOMMENDATION_RANKING_INVALID");
      return { rank: index + 1, title: material.title, operation: material.operation, target_digest: material.target_digest };
    });
    const contextId = text(input["context_id"]); const contextDigest = digest(input["context_digest"]);
    const contextRow = this.authority.db.prepare(
      "SELECT canonical_digest,canonical_envelope_json FROM personal_context_snapshots WHERE context_id=?",
    ).get(contextId);
    if (contextRow === undefined) return fail("RECOMMENDATION_CONTEXT_NOT_FOUND");
    const stored = object(contextRow, ["canonical_digest", "canonical_envelope_json"], "RECOMMENDATION_INPUT_INVALID");
    if (stored["canonical_digest"] !== contextDigest) return fail("RECOMMENDATION_EVIDENCE_CONFLICT");
    const context = parseContextSnapshotV1(JSON.parse(text(stored["canonical_envelope_json"], 65_536)));
    const now = parsedRanking.generated_at; const requestedExpiry = instant(input["expires_at"]);
    const expiresAt = [requestedExpiry, context.expires_at].sort()[0];
    if (expiresAt === undefined) return fail("RECOMMENDATION_INPUT_INVALID");
    const freshUntil = [context.freshness.fresh_until,
      new Date(Date.parse(expiresAt) - 1).toISOString()].sort()[0];
    if (freshUntil === undefined) return fail("RECOMMENDATION_INPUT_INVALID");
    if (context.payload.state !== "sufficient" || context.freshness.state !== "fresh"
      || now >= context.freshness.fresh_until || now >= context.expires_at
      || expiresAt <= now || freshUntil <= now) return fail("RECOMMENDATION_CONTEXT_STALE");
    const approval = input["approval_requirement"];
    if (approval !== "none" && approval !== "owner") return fail("RECOMMENDATION_INPUT_INVALID");
    const ownerRequired = selected.some(action => action.disposition === "owner_gate_required");
    if ((approval === "owner") !== ownerRequired) return fail("RECOMMENDATION_INPUT_INVALID");
    const confidence = input["confidence_class"];
    if (confidence !== "low" && confidence !== "medium" && confidence !== "high") return fail("RECOMMENDATION_INPUT_INVALID");
    let links: readonly RecommendationEvidenceLink[];
    try {
      links = deriveRecommendationEvidenceLinks({ database: this.authority.db, contextId, contextDigest,
        result: parsedRanking, actions: selected, supplied: provenanceInputs.evidenceLinks });
    } catch (error) {
      if (error instanceof RecommendationEvidenceBindingError) return fail("RECOMMENDATION_EVIDENCE_CONFLICT");
      throw error;
    }
    const provenance: RecommendationProvenance = { ranking: parsedRanking, linux_evidence: links, actions: supplied,
      approval_requirement: approval, confidence_class: confidence };
    let confidenceBasis: string;
    try { confidenceBasis = encodeRecommendationProvenance(provenance); }
    catch (error) {
      if (error instanceof RecommendationIdentityError) return fail("RECOMMENDATION_INPUT_INVALID");
      throw error;
    }
    const recommendation = parseRecommendationV1({
      schema_version: 1, id: recommendationId(input["id"]), created_at: now, observed_at: now, valid_at: now,
      source: { source_id: "src:pos:v1:jarvis:recommendations", source_kind: "authority",
        host_id: "host:pos:linux-control-plane", source_version: "task18-v1", evidence_ref: `ranking:${persistenceHash(provenance)}` },
      authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
      freshness: { ...context.freshness, fresh_until: freshUntil },
      expires_at: expiresAt, idempotency_key: text(input["idempotency_key"]),
      correlation_id: text(input["correlation_id"]), causation_id: input["causation_id"],
      payload: { context_id: context.id, context_digest: canonicalPersonalContractHash(context), actions: bound,
        citations: context.evidence.map(item => item.evidence_id), conflicts: context.payload.conflicts,
        omissions: context.payload.omissions, confidence_basis: confidenceBasis, state: "eligible" },
      policy_decision: { decision: "allow", policy_version: parsedRanking.policy_id,
        reason_codes: ["POLICY_SATISFIED"] }, evidence: context.evidence, receipt: null,
    });
    try {
      const persisted = this.authority.persistRecommendation({ recommendation, approval_requirement: approval,
        confidence_class: confidence }, now);
      const provenanceDigest = persistenceHash(provenance);
      return { recommendation, ...persisted, provenance_digest: provenanceDigest,
        identity_digest: persistenceHash({ canonical_digest: persisted.canonical_digest,
          context_evidence_digest: persisted.evidence_digest, provenance_digest: provenanceDigest }) };
    } catch (error) {
      if (error instanceof JarvisError) return mapPersistenceError(error);
      throw error;
    }
  }

  transition(value: unknown): void {
    const supersessionShape = typeof value === "object" && value !== null
      && Reflect.ownKeys(value).includes("replacement_recommendation_id");
    const raw = object(value, supersessionShape
      ? ["recommendation_id", "rank", "state", "evidence_digest", "occurred_at", "replacement_recommendation_id",
          "replacement_context_digest", "replacement_evidence_digest", "replacement_identity_digest"]
      : ["recommendation_id", "rank", "state", "evidence_digest", "occurred_at"], "RECOMMENDATION_INPUT_INVALID");
    const state = raw["state"];
    if (state !== "accepted" && state !== "rejected" && state !== "expired" && state !== "superseded") return fail("RECOMMENDATION_TRANSITION_CONFLICT");
    if (typeof raw["rank"] !== "number" || !Number.isSafeInteger(raw["rank"])
      || raw["rank"] < 1 || raw["rank"] > 32) return fail("RECOMMENDATION_INPUT_INVALID");
    try {
      this.authority.transitionRecommendationAction({ recommendation_id: recommendationId(raw["recommendation_id"]),
        rank: raw["rank"], state, evidence_digest: digest(raw["evidence_digest"]), occurred_at: instant(raw["occurred_at"]),
        ...(state === "superseded" ? { replacement_recommendation_id: recommendationId(raw["replacement_recommendation_id"]),
          replacement_context_digest: digest(raw["replacement_context_digest"]),
          replacement_evidence_digest: digest(raw["replacement_evidence_digest"]),
          replacement_identity_digest: digest(raw["replacement_identity_digest"]) } : {}) });
    } catch (error) {
      if (error instanceof JarvisError && error.code === "PERSONAL_ACTION_SUPERSESSION_CONFLICT") return fail("RECOMMENDATION_SUPERSESSION_CONFLICT");
      if (error instanceof RecommendationIdentityError) return fail("RECOMMENDATION_INPUT_INVALID");
      return mapPersistenceError(error);
    }
  }

  project(now: string, limit = 100): RecommendationReadProjection {
    const clock = instant(now);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return fail("RECOMMENDATION_INPUT_INVALID");
    try { return projectRecommendations(this.authority.db, clock, limit); }
    catch (error) {
      if (error instanceof RecommendationIdentityError) return fail("RECOMMENDATION_INPUT_INVALID");
      throw error;
    }
  }
}
export type { RecommendationActionMaterial, RecommendationEvidenceLink } from "./recommendation-provenance.js";
export type { RecommendationReadProjection, ProjectedRecommendationAction, RecommendationWarning } from "./recommendation-projection.js";
