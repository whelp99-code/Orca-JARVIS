import type { CapabilityFact, CapabilityMatrixV1, CapabilityStage } from "./capabilities.js";
import { ControlPlane, type StoredControlCommand } from "./control-plane.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import {
  loadRecommendationWorkflowAuthority,
  type RecommendationWorkflowBinding,
} from "./recommendation-workflow-authority.js";
import {
  parseRecommendationWorkflowRequest,
  parseStagedRecommendationWorkflow,
  stagedRecommendationWorkflowInput,
} from "./recommendation-workflow-input.js";
import { task25Date } from "./task25-closed-input.js";
import { planTeamProposal } from "./team-proposal.js";

export type { RecommendationWorkflowBinding } from "./recommendation-workflow-authority.js";
export type RecommendationWorkflowPolicy = {
  readonly repository: string;
  readonly environment: "local";
};
const STAGES = ["installed", "configured", "protocol_compatible", "operational", "authorized"] as const;
const CAPABILITIES = ["codex", "claude", "orca_read", "gjc", "live_resume"] as const;
const ACTION_LEVEL = 2 as const;
const LOOP_ID = "agentops-default" as const;
const TTL_MS = 15 * 60_000;
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
function readyProposal(
  request: ReturnType<typeof parseRecommendationWorkflowRequest>,
  evidenceDigest: string,
  now: string,
): Extract<ReturnType<typeof planTeamProposal>, { readonly status: "ready" }> {
  const proposal = planTeamProposal({
    schema_version: 1, objective: request.goal, work_type: "development",
    completion_evidence: [evidenceDigest],
    constraints: [`repository:${request.repository}`, `environment:${request.environment}`],
    requested_capabilities: [],
  }, policyMatrix(now));
  return proposal.status === "ready" ? proposal : fail();
}
export class RecommendationWorkflowStager {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly clock: () => unknown,
    private readonly policy: RecommendationWorkflowPolicy = { repository: "Orca-JARVIS", environment: "local" },
  ) {}
  stage(value: unknown): StoredControlCommand {
    const request = parseRecommendationWorkflowRequest(value);
    const now = task25Date(this.clock()); const nowText = now.toISOString();
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
    const state = loadRecommendationWorkflowAuthority(this.authority, request, nowText);
    if (Date.parse(state.expiresAt) <= now.getTime()) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
    const proposal = readyProposal(request, state.evidence_digest, nowText);
    const immutable = {
      recommendation_id: request.recommendationId, action_rank: request.actionRank,
      repository: request.repository, environment: request.environment, args_digest: state.args_digest,
    };
    const idempotencyKey = persistenceHash(immutable); const suffix = idempotencyKey.slice(7);
    const expires = new Date(Math.min(
      now.getTime() + TTL_MS, Date.parse(state.expiresAt), Date.parse(request.budget.deadline),
    )).toISOString();
    const binding: RecommendationWorkflowBinding & {
      readonly target_repository: string;
      readonly target_environment: "local";
    } = {
      ...state, proposal_digest: proposal.proposal_digest, idempotency_key: idempotencyKey,
      target_repository: request.repository, target_environment: request.environment,
    };
    const target = {
      environment: request.environment, repository: request.repository,
      run_id: `run:recommendation:${suffix}`, loop_id: LOOP_ID,
      correlation_id: request.recommendationId, task_id: request.recommendationId,
    };
    const args = {
      run_id: target.run_id, loop_id: LOOP_ID, correlation_id: request.recommendationId,
      budget: request.budget,
      input: { ...binding, goal: request.goal, workflow_args: request.workflowArgs, proposal },
    };
    return new ControlPlane(this.authority).stage({
      schema_version: 1, request_id: `request:recommendation:${suffix}`,
      action: "workflow.start", action_level: ACTION_LEVEL, target, args, reversible: true,
      requested_by: request.principalId, requested_at: nowText, expires_at: expires,
      nonce: `nonce:recommendation:${suffix}`,
    }, now);
  }
}
export function verifyRecommendationWorkflowBinding(
  authority: AuthorityDb,
  args: Readonly<Record<string, unknown>>,
  time: unknown,
): void {
  const now = task25Date(time); const input = stagedRecommendationWorkflowInput(args);
  const request = parseStagedRecommendationWorkflow(args);
  const current = loadRecommendationWorkflowAuthority(authority, request, now.toISOString());
  const proposal = readyProposal(request, current.evidence_digest, now.toISOString());
  if (input["proposal_digest"] !== proposal.proposal_digest) {
    return fail("RECOMMENDATION_WORKFLOW_BINDING_STALE");
  }
  const digestKeys = [
    "canonical_digest", "evidence_digest", "context_digest", "action_digest", "persistence_digest",
    "freshness_digest", "lifecycle_digest", "target_digest", "args_digest",
  ] as const;
  for (const key of digestKeys) {
    if (input[key] !== current[key]) return fail("RECOMMENDATION_WORKFLOW_BINDING_STALE");
  }
  if (Date.parse(current.expiresAt) <= now.getTime()) return fail("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE");
}
