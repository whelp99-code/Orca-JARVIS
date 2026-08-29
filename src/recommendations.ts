import type { RecommendationV1, Sha256Digest } from "./personal-contracts.js";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "./personal-validation.js";
import type { PriorityActionDecision, PriorityEngineResult } from "./priority-engine.js";
import { projectRecommendations, type RecommendationReadProjection } from "./recommendation-projection.js";

export const RECOMMENDATION_ERROR_CODES = [
  "RECOMMENDATION_INPUT_INVALID", "RECOMMENDATION_RANKING_INVALID", "RECOMMENDATION_CONTEXT_NOT_FOUND",
  "RECOMMENDATION_CONTEXT_STALE", "RECOMMENDATION_IDENTITY_CONFLICT", "RECOMMENDATION_EVIDENCE_CONFLICT",
  "RECOMMENDATION_TRANSITION_CONFLICT", "RECOMMENDATION_EXPIRED", "RECOMMENDATION_SUPERSESSION_CONFLICT",
] as const;
export type RecommendationErrorCode = (typeof RECOMMENDATION_ERROR_CODES)[number];
export class RecommendationError extends Error {
  constructor(readonly code: RecommendationErrorCode) { super(code); }
}
export type RecommendationActionMaterial = {
  readonly action_id: string;
  readonly title: string;
  readonly operation: string;
  readonly target_digest: string;
};
export type CreateRecommendationResult = {
  readonly recommendation: RecommendationV1;
  readonly canonical_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
};

const EFFECT_OPERATIONS = new Set(["execute", "dispatch", "stage", "claim", "redeem", "settle"]);
function fail(code: RecommendationErrorCode): never { throw new RecommendationError(code); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return fail("RECOMMENDATION_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string"
    || descriptors[String(key)]?.get !== undefined || descriptors[String(key)]?.set !== undefined)) {
    return fail("RECOMMENDATION_INPUT_INVALID");
  }
  return value;
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("RECOMMENDATION_INPUT_INVALID");
}
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) return fail("RECOMMENDATION_INPUT_INVALID"); return value; }
function digest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) fail("RECOMMENDATION_INPUT_INVALID");
  return result;
}
function safeTree(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) { value.forEach(safeTree); return; }
  const input = record(value);
  for (const [key, child] of Object.entries(input)) {
    if (EFFECT_OPERATIONS.has(key.toLowerCase())) fail("RECOMMENDATION_INPUT_INVALID");
    if (Array.isArray(child)) child.forEach(safeTree); else safeTree(child);
  }
}
function isPriorityResult(value: unknown): value is PriorityEngineResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Reflect.get(value, "status") === "ranked" && Reflect.get(value, "authority") === "none"
    && Reflect.get(value, "effect") === "none" && typeof Reflect.get(value, "generated_at") === "string"
    && typeof Reflect.get(value, "policy_id") === "string" && Array.isArray(Reflect.get(value, "actions"));
}
function rankedResult(value: unknown): PriorityEngineResult {
  safeTree(value); record(value);
  if (!isPriorityResult(value)) return fail("RECOMMENDATION_RANKING_INVALID");
  return value;
}
function rankedActions(result: PriorityEngineResult): readonly PriorityActionDecision[] {
  const actions = result.actions.filter(action => action.rank !== null && action.disposition !== "excluded" && action.disposition !== "abstained");
  if (actions.length === 0 || actions.some((action, index) => action.rank !== index + 1 || action.authority !== "none")) fail("RECOMMENDATION_RANKING_INVALID");
  return actions;
}
function materials(value: unknown): readonly RecommendationActionMaterial[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return fail("RECOMMENDATION_INPUT_INVALID");
  return value.map(item => {
    const input = record(item); exact(input, ["action_id", "title", "operation", "target_digest"]);
    const operation = text(input["operation"]);
    if (EFFECT_OPERATIONS.has(operation.toLowerCase())) fail("RECOMMENDATION_INPUT_INVALID");
    return { action_id: text(input["action_id"]), title: text(input["title"]), operation, target_digest: digest(input["target_digest"]) };
  });
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
    safeTree(value); const input = record(value);
    exact(input, [
      "id", "idempotency_key", "correlation_id", "causation_id", "context_id", "context_digest",
      "expires_at", "ranking", "actions", "approval_requirement", "confidence_class",
    ]);
    const ranking = rankedResult(input["ranking"]); const selected = rankedActions(ranking); const supplied = materials(input["actions"]);
    if (selected.length !== supplied.length) return fail("RECOMMENDATION_RANKING_INVALID");
    const byId = new Map(supplied.map(action => [action.action_id, action]));
    const bound = selected.map((action, index) => {
      const material = byId.get(action.action_id); if (material === undefined || action.rank !== index + 1) return fail("RECOMMENDATION_RANKING_INVALID");
      return { rank: index + 1, title: material.title, operation: material.operation, target_digest: material.target_digest };
    });
    if (new Set(supplied.map(action => action.action_id)).size !== supplied.length) return fail("RECOMMENDATION_INPUT_INVALID");
    const contextId = text(input["context_id"]);
    const contextRow = this.authority.db.prepare(
      "SELECT canonical_digest,canonical_envelope_json FROM personal_context_snapshots WHERE context_id=?",
    ).get(contextId);
    if (contextRow === undefined) return fail("RECOMMENDATION_CONTEXT_NOT_FOUND");
    const contextRecord = record(contextRow);
    if (contextRecord["canonical_digest"] !== digest(input["context_digest"])) {
      return fail("RECOMMENDATION_EVIDENCE_CONFLICT");
    }
    const context = parseContextSnapshotV1(JSON.parse(text(contextRecord["canonical_envelope_json"])));
    const now = ranking.generated_at;
    if (context.payload.state !== "sufficient" || context.freshness.state !== "fresh"
      || Date.parse(context.freshness.fresh_until) <= Date.parse(now)
      || Date.parse(context.expires_at) <= Date.parse(now)) return fail("RECOMMENDATION_CONTEXT_STALE");
    const approval = input["approval_requirement"];
    if ((approval !== "none" && approval !== "owner")
      || (selected.some(action => action.disposition === "owner_gate_required") && approval !== "owner")) {
      return fail("RECOMMENDATION_INPUT_INVALID");
    }
    const confidence = input["confidence_class"];
    if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
      return fail("RECOMMENDATION_INPUT_INVALID");
    }
    const recommendation = parseRecommendationV1({
      schema_version: 1, id: text(input["id"]), created_at: now, observed_at: now, valid_at: now,
      source: {
        source_id: "src:pos:v1:jarvis:recommendations", source_kind: "authority",
        host_id: "host:pos:linux-control-plane", source_version: "task18-v1",
        evidence_ref: `ranking:${canonicalPersonalContractHash(context)}`,
      },
      authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
      freshness: context.freshness, expires_at: text(input["expires_at"]), idempotency_key: text(input["idempotency_key"]),
      correlation_id: text(input["correlation_id"]), causation_id: input["causation_id"],
      payload: { context_id: context.id, context_digest: canonicalPersonalContractHash(context), actions: bound,
        citations: context.evidence.map(item => item.evidence_id), conflicts: context.payload.conflicts, omissions: context.payload.omissions,
        confidence_basis: canonicalize(ranking), state: "eligible" },
      policy_decision: { decision: "allow", policy_version: ranking.policy_id, reason_codes: ["POLICY_SATISFIED"] }, evidence: context.evidence, receipt: null,
    });
    try {
      const stored = this.authority.persistRecommendation({ recommendation, approval_requirement: approval, confidence_class: confidence }, now);
      return { recommendation, ...stored };
    } catch (error) {
      if (error instanceof JarvisError) return mapPersistenceError(error);
      throw error;
    }
  }

  transition(value: unknown): void {
    safeTree(value); const input = record(value);
    const superseded = input["state"] === "superseded";
    exact(input, superseded
      ? [
          "recommendation_id", "rank", "state", "evidence_digest", "occurred_at",
          "replacement_recommendation_id", "replacement_context_digest", "replacement_evidence_digest",
        ]
      : ["recommendation_id", "rank", "state", "evidence_digest", "occurred_at"]);
    const state = input["state"];
    if (state !== "accepted" && state !== "rejected" && state !== "expired" && state !== "superseded") return fail("RECOMMENDATION_TRANSITION_CONFLICT");
    try {
      this.authority.transitionRecommendationAction({
        recommendation_id: text(input["recommendation_id"]), rank: Number(input["rank"]), state,
        evidence_digest: digest(input["evidence_digest"]), occurred_at: text(input["occurred_at"]),
        ...(superseded ? {
          replacement_recommendation_id: text(input["replacement_recommendation_id"]),
          replacement_context_digest: digest(input["replacement_context_digest"]),
          replacement_evidence_digest: digest(input["replacement_evidence_digest"]),
        } : {}),
      });
    } catch (error) {
      if (error instanceof JarvisError && error.code === "PERSONAL_ACTION_SUPERSESSION_CONFLICT") return fail("RECOMMENDATION_SUPERSESSION_CONFLICT");
      return mapPersistenceError(error);
    }
  }

  project(now: string, limit = 100): RecommendationReadProjection {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(now)) return fail("RECOMMENDATION_INPUT_INVALID");
    return projectRecommendations(this.authority.db, now, limit);
  }
}
export type { RecommendationReadProjection, ProjectedRecommendationAction, RecommendationWarning } from "./recommendation-projection.js";
