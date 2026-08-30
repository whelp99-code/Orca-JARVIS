import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { canonicalize } from "./canonical.js";
import {
  controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput,
} from "./control-plane.js";
import { controlWorkflowRunInput } from "./control-workflow-input.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { workflowInputDigest } from "./workflow-stage-outcome.js";
import { verifyRecommendationWorkflowBinding } from "./recommendation-workflow-staging.js";
import type { PreparedRecommendationWork } from "./recommendation-work-types.js";

export type RecommendationWorkIdentity = {
  readonly runtime_id: string; readonly request_id: string; readonly receipt_id: string;
  readonly redemption_fence: number; readonly run_id: string; readonly task_id: string;
  readonly workflow_digest: string; readonly dispatch_intent_id: string;
  readonly verification_request_id: string; readonly implementer_principal_id: string;
  readonly correlation: Readonly<Record<string, unknown>>;
};
function fail(): never { throw new JarvisError("RECOMMENDATION_WORK_AUTHORITY_INVALID"); }
function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : fail();
}
function text(value: unknown): string { return typeof value === "string" && value.length > 0 ? value : fail(); }
export function reconstructRecommendationWork(db: AuthorityDb, requestId: string, now: Date): RecommendationWorkIdentity {
  const row = db.db.prepare(`SELECT r.*,a.receipt_id,a.command_digest AS receipt_command_digest,
    a.signer_principal_id,a.authenticated_session_id,a.payload_json AS receipt_payload_json,
    a.key_id AS receipt_key_id,x.lease_fence AS redemption_fence,
    e.payload_json AS effect_json,w.input_json AS workflow_input_json,w.budget_json AS workflow_budget_json,
    w.correlation_id,w.loop_id,w.created_at AS workflow_created_at
    FROM control_command_requests r
    JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve'
    JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.receipt_id=a.receipt_id
    JOIN control_command_effects e ON e.request_id=r.request_id
      AND e.effect_type='recommendation.workflow.staged'
    JOIN workflow_runs w ON w.run_id=json_extract(r.target_json,'$.run_id')
    WHERE r.request_id=? AND r.action='workflow.start' AND r.state='completed'
      AND r.command_digest=a.command_digest AND r.lease_fence=x.lease_fence`).get(requestId) as
      Readonly<Record<string, unknown>> | undefined;
  if (row === undefined) return fail();
  const target = record(JSON.parse(text(row["target_json"]))); const args = record(JSON.parse(text(row["args_json"])));
  const command: ControlCommandRequestInput = { schema_version: 1, request_id: text(row["request_id"]),
    action: text(row["action"]), action_level: Number(row["action_level"]) as ControlCommandRequestInput["action_level"],
    target: { ...target }, args: { ...args }, reversible: Boolean(row["reversible"]),
    requested_by: text(row["requested_by"]), requested_at: text(row["requested_at"]),
    expires_at: text(row["expires_at"]), nonce: text(row["nonce"]) };
  if (controlCommandDigest(command) !== row["command_digest"]) return fail();
  const receipt = JSON.parse(text(row["receipt_payload_json"])) as CommandApprovalReceipt;
  const verifier = db.db.prepare(`SELECT k.public_key_pem FROM trusted_authority_keys k
    JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision' WHERE k.key_id=?`)
    .get(row["receipt_key_id"]) as { public_key_pem: string } | undefined;
  if (verifier === undefined || receipt.receipt_id !== row["receipt_id"]
    || receipt.request_id !== row["request_id"] || receipt.command_digest !== row["command_digest"]
    || !verifyCommandApproval(receipt, verifier.public_key_pem, new Date(receipt.issued_at))) return fail();
  verifyRecommendationWorkflowBinding(db, args, now);
  const input = record(args["input"]); const proposal = record(input["proposal"]);
  const members = proposal["members"];
  if (!Array.isArray(members)) return fail();
  const builder = members.map(record).find(member => member["archetype"] === "builder");
  if (builder === undefined || text(row["requested_by"]) !== text(row["signer_principal_id"])) return fail();
  const workflow = controlWorkflowRunInput(args); const workflowDigest = workflowInputDigest(workflow);
  if (workflow.run_id !== text(target["run_id"]) || workflow.correlation_id !== text(row["correlation_id"])
    || canonicalize(workflow.input) !== text(row["workflow_input_json"])
    || canonicalize(workflow.budget) !== text(row["workflow_budget_json"])) return fail();
  const fixed = {
    request_id: requestId, receipt_id: text(row["receipt_id"]), redemption_fence: Number(row["redemption_fence"]),
    command_digest: text(row["command_digest"]), recommendation_id: text(input["recommendation_id"]),
    action_rank: Number(input["action_rank"]), context_id: text(input["context_id"]),
    canonical_digest: text(input["canonical_digest"]), evidence_digest: text(input["evidence_digest"]),
    context_digest: text(input["context_digest"]), action_digest: text(input["action_digest"]),
    persistence_digest: text(input["persistence_digest"]), freshness_digest: text(input["freshness_digest"]),
    lifecycle_digest: text(input["lifecycle_digest"]), target_digest: text(input["target_digest"]),
    args_digest: text(input["args_digest"]), proposal_digest: text(input["proposal_digest"]),
    idempotency_key: text(input["idempotency_key"]), run_id: workflow.run_id, loop_id: workflow.loop_id,
    correlation_id: workflow.correlation_id, task_id: text(target["task_id"]), workflow_digest: workflowDigest,
    repository: text(input["target_repository"]), environment: text(input["target_environment"]),
    budget: workflow.budget, authenticated_session_id: text(input["authenticated_session_id"]),
    requested_by_principal_id: text(input["requested_by_principal_id"]),
    implementer_principal_id: text(builder["member_id"]), workflow_created_at: text(row["workflow_created_at"]),
  };
  const identityDigest = persistenceHash(fixed); const runtimeId = `recommendation-work:${identityDigest.slice(7)}`;
  return { runtime_id: runtimeId, request_id: requestId, receipt_id: fixed.receipt_id,
    redemption_fence: fixed.redemption_fence, run_id: workflow.run_id, task_id: fixed.task_id,
    workflow_digest: workflowDigest, dispatch_intent_id: `dispatch:${identityDigest.slice(7)}`,
    verification_request_id: `verification:${identityDigest.slice(7)}`,
    implementer_principal_id: fixed.implementer_principal_id, correlation: fixed };
}
export function prepared(identity: RecommendationWorkIdentity, state: string): PreparedRecommendationWork {
  return { runtime_id: identity.runtime_id, request_id: identity.request_id, run_id: identity.run_id,
    workflow_digest: identity.workflow_digest, dispatch_intent_id: identity.dispatch_intent_id,
    verification_request_id: identity.verification_request_id, state };
}
