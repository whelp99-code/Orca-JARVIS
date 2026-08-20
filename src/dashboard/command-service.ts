import { buildCapabilityMatrix, type CapabilityProbe } from "../capabilities.js";
import { ControlPlane, type ControlCommandRequestInput, type StoredControlCommand } from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { TeamProposalResultV1 } from "../team-proposal.js";
import type { CreateTaskRequest } from "./contracts.js";
import type { TeamProposalPlanner } from "./proposal-service.js";

const PROPOSAL_STALE = "PROPOSAL_STALE" as const;
const REQUESTED_BY = "jarvis-control-center" as const;
const LOOP_ID = "agentops-default" as const;
const ACTION = "workflow.start" as const;
const ACTION_LEVEL = 2 as const;
const REQUEST_TTL_MS = 15 * 60_000;
const DEADLINE_MAX_MS = 24 * 60 * 60_000;

export type StageDashboardTaskInput = {
  readonly db: AuthorityDb;
  readonly capabilityProbe: CapabilityProbe;
  readonly planner: TeamProposalPlanner;
  readonly now: Date;
  readonly request: CreateTaskRequest;
};

export async function stageDashboardTask(input: StageDashboardTaskInput): Promise<StoredControlCommand> {
  assertBudgetDeadline(input.request.budget.deadline, input.now);
  const planned = await planReadyProposal(input);
  return new ControlPlane(input.db).stage(workflowStartCommand(input.request, planned, input.now), input.now);
}

function assertBudgetDeadline(deadline: string, now: Date): void {
  const deadlineMs = Date.parse(deadline);
  const nowMs = now.getTime();
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs) || deadlineMs <= nowMs || deadlineMs - nowMs > DEADLINE_MAX_MS) {
    throw new JarvisError("TASK_INPUT_INVALID");
  }
}

async function planReadyProposal(
  input: StageDashboardTaskInput,
): Promise<Extract<TeamProposalResultV1, { readonly status: "ready" }>> {
  const matrix = await buildCapabilityMatrix(input.db, input.capabilityProbe, input.now);
  const planned = input.planner(input.request.proposal_request, matrix);
  switch (planned.status) {
    case "ready":
      if (planned.proposal_digest !== input.request.expected_proposal_digest) {
        throw new JarvisError(PROPOSAL_STALE);
      }
      return planned;
    case "blocked":
      throw new JarvisError("CONTROL_STATE_CONFLICT");
    case "needs_input":
      throw new JarvisError("VALIDATION_ERROR");
    default:
      return assertNever(planned);
  }
}

function workflowStartCommand(
  request: CreateTaskRequest,
  planned: Extract<TeamProposalResultV1, { readonly status: "ready" }>,
  now: Date,
): ControlCommandRequestInput {
  const target: Record<string, unknown> = {
    environment: "local",
    run_id: request.run_id,
    loop_id: LOOP_ID,
    correlation_id: request.task_id,
    task_id: request.task_id,
  };
  const args: Record<string, unknown> = {
    run_id: request.run_id,
    loop_id: LOOP_ID,
    correlation_id: request.task_id,
    budget: request.budget,
    input: {
      task_id: request.task_id,
      objective: request.proposal_request.objective,
      proposal_digest: planned.proposal_digest,
      members: planned.members,
    },
  };
  return {
    schema_version: 1,
    request_id: request.request_id,
    action: ACTION,
    action_level: ACTION_LEVEL,
    target,
    args,
    reversible: true,
    requested_by: REQUESTED_BY,
    requested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
    nonce: request.nonce,
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected team proposal status: ${JSON.stringify(value)}`);
}
