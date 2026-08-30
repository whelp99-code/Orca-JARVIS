import type Database from "better-sqlite3";
import type { CapabilityFact, CapabilityMatrixV1, CapabilityStage } from "./capabilities.js";
import { ControlPlane, type StoredControlCommand } from "./control-plane.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "./personal-validation.js";
import { persistenceHash, persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";
import {
  parseRecommendationWorkflowRequest,
  parseStagedRecommendationWorkflow,
  stagedRecommendationWorkflowInput,
  type ParsedRecommendationWorkflowRequest,
} from "./recommendation-workflow-input.js";
import { planTeamProposal } from "./team-proposal.js";

const STAGES = ["installed", "configured", "protocol_compatible", "operational", "authorized"] as const;
const CAPABILITIES = ["codex", "claude", "orca_read", "gjc", "live_resume"] as const;
const ELIGIBLE = new Set(["eligible", "presented", "selected"]);
const ACTION_LEVEL = 2 as const;
const LOOP_ID = "agentops-default" as const;
const TTL_MS = 15 * 60_000;

export type RecommendationWorkflowPolicy = {
  readonly repository: string;
  readonly environment: "local";
};
export type RecommendationWorkflowBinding = {
  readonly recommendation_id: string;
  readonly action_rank: number;
  readonly context_id: string;
  readonly canonical_digest: string;
  readonly evidence_digest: string;
  readonly context_digest: string;
  readonly action_digest: string;
  readonly persistence_digest: string;
  readonly freshness_digest: string;
  readonly lifecycle_digest: string;
  readonly target_digest: string;
  readonly args_digest: string;
  readonly proposal_digest: string;
  readonly requested_by_principal_id: string;
  readonly authenticated_session_id: string;
  readonly idempotency_key: string;
};

type CanonicalState = RecommendationWorkflowBinding & {
  readonly action: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
};

function fail(code = "RECOMMENDATION_WORKFLOW_INVALID"): never { throw new JarvisError(code); }
function policyMatrix(now: string): CapabilityMatrixV1 {
  const fact = (id: CapabilityFact["id"]): CapabilityFact => ({
    id,
    stages: Object.fromEntries(STAGES.map(stage => [
      stage, { ok: true, evidence: "fixed_policy_authority" },
    ])) as Record<CapabilityStage, { ok: boolean; evidence: string }>,
  });
  return { schema_version: 1, checked_at: now, capabilities: CAPABILITIES.map(fact) };
}
function canonicalState(
  database: Database.Database,
  request: ParsedRecommendationWorkflowRequest,
): CanonicalState {
  const value = database.prepare(`SELECT r.*,c.canonical_digest AS stored_context_digest,c.persistence_digest AS context_persistence_digest,
    c.canonical_envelope_json AS context_envelope,c.expires_at AS context_expires,c.fresh_until AS context_fresh_until,
    a.title,a.operation,a.target_digest,a.initial_state,
    (SELECT state FROM personal_recommendation_action_events e
      WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
      ORDER BY event_sequence DESC LIMIT 1) AS action_state,
    (SELECT COALESCE(transition_digest,evidence_digest) FROM personal_recommendation_action_events e
      WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
      ORDER BY event_sequence DESC LIMIT 1) AS lifecycle_identity
    FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
    JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
    WHERE r.recommendation_id=? AND a.rank=?`).get(request.recommendationId, request.actionRank);
  if (value === undefined) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
  const row = persistenceRow(value); const recommendation = parseRecommendationV1(JSON.parse(persistenceText(row["canonical_envelope_json"])));
  const context = parseContextSnapshotV1(JSON.parse(persistenceText(row["context_envelope"])));
  const canonicalDigest = canonicalPersonalContractHash(recommendation); const contextDigest = canonicalPersonalContractHash(context);
  const evidenceDigest = persistenceHash(recommendation.evidence);
  const persistenceDigest = persistenceHash({
    approval_requirement: row["approval_requirement"],
    canonical_digest: canonicalDigest,
    confidence_class: row["confidence_class"],
  });
  const action = { rank: request.actionRank, title: row["title"], operation: row["operation"], target_digest: row["target_digest"] };
  const identity = storedRecommendationIdentity(canonicalDigest, evidenceDigest, row["canonical_envelope_json"]);
  const recommendationEvidence = database.prepare(
    `SELECT evidence_id,source_id,evidence_digest,observed_at
     FROM personal_recommendation_evidence WHERE recommendation_id=? ORDER BY position`,
  ).all(request.recommendationId).map(persistenceRow);
  const exactRecommendationEvidence = recommendation.evidence.length === recommendationEvidence.length && recommendation.evidence.every((item, index) => {
    const stored = recommendationEvidence[index]; return stored !== undefined && stored["evidence_id"] === item.evidence_id
      && stored["source_id"] === item.source_id && stored["evidence_digest"] === item.digest && stored["observed_at"] === item.observed_at;
  });
  const contextEvidence = database.prepare(`SELECT evidence_id,source_id,evidence_kind AS kind,
    evidence_digest AS digest,observed_at FROM personal_context_evidence WHERE context_id=? ORDER BY position`
  ).all(context.id).map(persistenceRow);
  const exactContextEvidence = context.evidence.length === contextEvidence.length
    && context.evidence.every((item, index) => {
      const stored = contextEvidence[index]; return stored !== undefined
        && stored["evidence_id"] === item.evidence_id && stored["source_id"] === item.source_id
        && stored["kind"] === item.kind && stored["digest"] === item.digest
        && stored["observed_at"] === item.observed_at;
    });
  const memoryEvidence = database.prepare(`SELECT m.memory_ref,m.evidence_id,m.source_id,m.evidence_digest AS digest,m.observed_at,m.fresh_until
    FROM personal_context_memory_evidence m JOIN personal_context_evidence e ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
    WHERE m.context_id=? ORDER BY e.position,m.memory_ref`).all(context.id).map(persistenceRow);
  const contextPersistenceDigest = persistenceHash({ canonical_digest: contextDigest, memory_evidence: memoryEvidence });
  if (row["canonical_digest"] !== canonicalDigest || row["evidence_digest"] !== evidenceDigest || row["context_digest"] !== contextDigest
    || row["stored_context_digest"] !== contextDigest || row["persistence_digest"] !== persistenceDigest
    || row["context_persistence_digest"] !== contextPersistenceDigest
    || !exactContextEvidence || !exactRecommendationEvidence
    || recommendation.payload.context_digest !== contextDigest || row["approval_requirement"] !== "owner"
    || !ELIGIBLE.has(String(row["lifecycle_state"])) || row["initial_state"] !== "pending" || row["action_state"] !== "pending"
    || !identity.provenance.actions.some(item => item.title === row["title"]
      && item.operation === row["operation"]
      && item.target_digest === row["target_digest"])) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
  return { recommendation_id: request.recommendationId, action_rank: request.actionRank, context_id: context.id,
    canonical_digest: canonicalDigest, evidence_digest: evidenceDigest, context_digest: contextDigest,
    action_digest: persistenceHash(action), persistence_digest: persistenceDigest,
    freshness_digest: persistenceHash({ recommendation: recommendation.freshness, context: context.freshness }),
    lifecycle_digest: persistenceHash({
      lifecycle_state: row["lifecycle_state"], action_state: row["action_state"],
      lifecycle_identity: row["lifecycle_identity"],
    }),
    target_digest: persistenceHash({ repository: request.repository, environment: request.environment }), args_digest: persistenceHash(request.workflowArgs),
    proposal_digest: "", requested_by_principal_id: request.principalId, authenticated_session_id: request.sessionId, idempotency_key: "", action,
    expiresAt: [recommendation.expires_at, recommendation.freshness.fresh_until, context.expires_at, context.freshness.fresh_until].sort()[0] ?? fail() };
}

export class RecommendationWorkflowStager {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly clock: () => Date,
    private readonly policy: RecommendationWorkflowPolicy = { repository: "Orca-JARVIS", environment: "local" },
  ) {}
  stage(value: unknown): StoredControlCommand {
    const request = parseRecommendationWorkflowRequest(value);
    const now = this.clock(); const nowText = now.toISOString();
    if (request.repository !== this.policy.repository
      || request.environment !== this.policy.environment
      || Date.parse(request.budget.deadline) <= now.getTime()) {
      return fail("RECOMMENDATION_WORKFLOW_TARGET_MISMATCH");
    }
    const key = this.authority.db.prepare(
      `SELECT 1 FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id
       WHERE k.principal_id=? AND p.purpose='decision'`,
    ).get(request.principalId);
    if (key === undefined) return fail("RECOMMENDATION_WORKFLOW_PRINCIPAL_INVALID");
    const state = canonicalState(this.authority.db, request);
    if (Date.parse(state.expiresAt) <= now.getTime()) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
    const proposal = planTeamProposal({
      schema_version: 1, objective: request.goal, work_type: "development",
      completion_evidence: [state.evidence_digest],
      constraints: [`repository:${request.repository}`, `environment:${request.environment}`],
      requested_capabilities: [],
    }, policyMatrix(nowText));
    if (proposal.status !== "ready") return fail();
    const immutable = {
      recommendation_id: request.recommendationId, action_rank: request.actionRank,
      repository: request.repository, environment: request.environment, args_digest: state.args_digest,
    };
    const idempotencyKey = persistenceHash(immutable); const suffix = idempotencyKey.slice(7);
    const expires = new Date(Math.min(
      now.getTime() + TTL_MS, Date.parse(state.expiresAt), Date.parse(request.budget.deadline),
    )).toISOString();
    const binding: RecommendationWorkflowBinding & { readonly target_repository: string; readonly target_environment: "local" } = {
      ...state, proposal_digest: proposal.proposal_digest, idempotency_key: idempotencyKey,
      target_repository: request.repository, target_environment: request.environment,
    };
    const target = {
      environment: request.environment, repository: request.repository,
      run_id: `run:recommendation:${suffix}`, loop_id: LOOP_ID,
      correlation_id: request.recommendationId, task_id: request.recommendationId,
    };
    const args = { run_id: target.run_id, loop_id: LOOP_ID, correlation_id: request.recommendationId, budget: request.budget,
      input: { ...binding, goal: request.goal, workflow_args: request.workflowArgs, proposal } };
    return new ControlPlane(this.authority).stage({
      schema_version: 1, request_id: `request:recommendation:${suffix}`,
      action: "workflow.start", action_level: ACTION_LEVEL, target, args, reversible: true,
      requested_by: request.principalId, requested_at: nowText, expires_at: expires,
      nonce: `nonce:recommendation:${suffix}`,
    }, now);
  }
}

export function verifyRecommendationWorkflowBinding(authority: AuthorityDb, args: Readonly<Record<string, unknown>>, now: Date): void {
  const input = stagedRecommendationWorkflowInput(args);
  const request = parseStagedRecommendationWorkflow(args);
  const current = canonicalState(authority.db, request);
  const proposal = planTeamProposal({ schema_version: 1, objective: request.goal, work_type: "development",
    completion_evidence: [current.evidence_digest], constraints: [`repository:${request.repository}`, "environment:local"],
    requested_capabilities: [] }, policyMatrix(now.toISOString()));
  if (proposal.status !== "ready" || input["proposal_digest"] !== proposal.proposal_digest) return fail("RECOMMENDATION_WORKFLOW_BINDING_STALE");
  const digestKeys = [
    "canonical_digest", "evidence_digest", "context_digest", "action_digest", "persistence_digest",
    "freshness_digest", "lifecycle_digest", "target_digest", "args_digest",
  ] as const;
  for (const key of digestKeys) {
    if (input[key] !== current[key]) return fail("RECOMMENDATION_WORKFLOW_BINDING_STALE");
  }
  if (Date.parse(current.expiresAt) <= now.getTime()) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
}
