import { JarvisError, type AuthorityDb } from "./db.js";
import type { ApprovedExecutionResult } from "./approved-executor.js";
import { type ClaimedControlCommand, type ControlPlane } from "./control-plane.js";
import { controlWorkflowRunInput } from "./control-workflow-input.js";
import type { WorkflowRunInput } from "./loopgraph.js";
import { verifyRecommendationWorkflowBinding } from "./recommendation-workflow-staging.js";

export interface WorkflowStageAdapter {
  stage(input: WorkflowRunInput, now: Date): Promise<unknown>;
}
export type ExecuteWorkflowStageInput = {
  readonly requestId: string;
  readonly worker: string;
  readonly adapter: WorkflowStageAdapter;
  readonly now: Date;
};
const ACTIVE_WORKFLOW_STAGES = new Set<string>();

type Context = {
  readonly authority: AuthorityDb;
  readonly control: ControlPlane;
  readonly input: ExecuteWorkflowStageInput;
};
function completed(context: Context): ApprovedExecutionResult | undefined {
  const row = context.authority.db.prepare(
    `SELECT r.action,e.payload_json,c.source FROM control_command_requests r
     JOIN control_command_effects e
       ON e.request_id=r.request_id AND e.effect_type='recommendation.workflow.staged'
     JOIN control_events c ON c.event_id='evt:' || r.request_id || ':claimed:' || r.lease_fence
     WHERE r.request_id=? AND r.state='completed'`,
  ).get(context.input.requestId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (row.source !== context.input.worker) {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_EXECUTOR_CONFLICT");
  }
  return {
    request_id: context.input.requestId,
    action: String(row.action), state: "completed",
    result: JSON.parse(String(row.payload_json)),
  };
}
function requireReceipt(context: Context, args: Readonly<Record<string, unknown>>): void {
  const row = context.authority.db.prepare(
    `SELECT r.requested_by,a.signer_principal_id,a.authenticated_session_id
     FROM control_command_requests r
     JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve'
     WHERE r.request_id=? AND r.state='approved'`,
  ).get(context.input.requestId) as Record<string, unknown> | undefined;
  if (row === undefined) return;
  const binding = args.input;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)
    || row.requested_by !== row.signer_principal_id
    || Reflect.get(binding, "requested_by_principal_id") !== row.signer_principal_id
    || Reflect.get(binding, "authenticated_session_id") !== row.authenticated_session_id) {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_RECEIPT_MISMATCH");
  }
}
function resume(context: Context): ClaimedControlCommand {
  const row = context.authority.db.prepare(
    `SELECT r.*,x.receipt_id,a.expires_at AS approval_expires,
            a.signer_principal_id,a.authenticated_session_id,x.lease_fence AS redemption_fence
     FROM control_command_requests r JOIN control_command_redemptions x ON x.request_id=r.request_id
     JOIN control_command_receipts a ON a.receipt_id=x.receipt_id WHERE r.request_id=?`,
  ).get(context.input.requestId) as Record<string, unknown> | undefined;
  if (row === undefined || row.state !== "claimed" || row.lease_owner !== context.input.worker
    || Number(row.lease_fence) !== Number(row.redemption_fence)
    || Date.parse(String(row.lease_expires_at)) <= context.input.now.getTime()
    || Date.parse(String(row.expires_at)) <= context.input.now.getTime()
    || Date.parse(String(row.approval_expires)) <= context.input.now.getTime()) {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_EXECUTOR_CONFLICT");
  }
  const target = JSON.parse(String(row.target_json)) as Record<string, unknown>;
  const args = JSON.parse(String(row.args_json)) as Record<string, unknown>;
  const binding = args.input;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)
    || row.requested_by !== row.signer_principal_id
    || Reflect.get(binding, "requested_by_principal_id") !== row.signer_principal_id
    || Reflect.get(binding, "authenticated_session_id") !== row.authenticated_session_id) {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_RECEIPT_MISMATCH");
  }
  return {
    request_id: context.input.requestId, receipt_id: String(row.receipt_id),
    action: String(row.action), action_level: Number(row.action_level) as ClaimedControlCommand["action_level"],
    target, args, command_digest: String(row.command_digest), reversible: Boolean(row.reversible),
    fence: Number(row.lease_fence), lease_expires_at: String(row.lease_expires_at),
  };
}
export async function executeApprovedWorkflowStage(context: Context): Promise<ApprovedExecutionResult> {
  const prior = completed(context);
  if (prior !== undefined) return prior;
  if (ACTIVE_WORKFLOW_STAGES.has(context.input.requestId)) {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_EXECUTOR_CONFLICT");
  }
  const stored = context.control.list().find(item => item.request_id === context.input.requestId);
  if (stored === undefined || stored.action !== "workflow.start") {
    throw new JarvisError("RECOMMENDATION_WORKFLOW_EXECUTOR_INVALID");
  }
  verifyRecommendationWorkflowBinding(context.authority, stored.args, context.input.now);
  requireReceipt(context, stored.args);
  let command: ClaimedControlCommand;
  try { command = context.control.claim(context.input.requestId, context.input.worker, context.input.now); }
  catch (error) {
    if (!(error instanceof JarvisError) || error.code !== "CONTROL_APPROVAL_REQUIRED"
      || stored.state !== "claimed") throw error;
    command = resume(context);
  }
  ACTIVE_WORKFLOW_STAGES.add(context.input.requestId);
  try {
    const result = await context.input.adapter.stage(controlWorkflowRunInput(command.args), context.input.now);
    context.control.settle(context.input.requestId, command.fence, {
      state: "completed", effect_type: "recommendation.workflow.staged", payload: result,
    }, context.input.now);
    return { request_id: context.input.requestId, action: command.action, state: "completed", result };
  } catch (error) {
    const result = { error: error instanceof Error ? error.message : "unknown" };
    context.control.settle(context.input.requestId, command.fence, {
      state: "uncertain", effect_type: "recommendation.workflow.stage.uncertain", payload: result,
      failure_code: "RECOMMENDATION_WORKFLOW_STAGE_UNCERTAIN",
    }, context.input.now);
    return {
      request_id: context.input.requestId, action: command.action, state: "uncertain", result,
      failure_code: "RECOMMENDATION_WORKFLOW_STAGE_UNCERTAIN",
    };
  } finally { ACTIVE_WORKFLOW_STAGES.delete(context.input.requestId); }
}
