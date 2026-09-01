import { resolve } from "node:path";
import { ApprovedCommandExecutor, type ApprovedExecutionResult } from "../approved-executor.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import { controlActionDescriptor } from "../control-actions.js";
import {
  ControlPlane,
  type ControlCommandRequestInput,
  type StoredControlCommand,
} from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { LoopGraph, type StoredWorkflowRun } from "../loopgraph.js";
import {
  parseAuthorityDecision,
  parseCancelRequest,
  parseExecuteRequest,
  parseRetryRequest,
} from "./authority-validation.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";

const REQUESTED_BY = "jarvis-control-center" as const;
const REQUEST_TTL_MS = 15 * 60_000;
const TERMINAL_STATES = new Set(["completed", "failed", "uncertain", "cancelled"]);

export type DashboardDecision = {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly decision: "approve" | "reject";
  readonly state: "approved" | "rejected";
};

export type DashboardExecution = {
  readonly schema_version: 1;
  readonly execution: {
    readonly request_id: string;
    readonly action: string;
    readonly state: ApprovedExecutionResult["state"];
    readonly failure_code?: string;
  };
};

export type DecideInput = {
  readonly db: AuthorityDb;
  readonly requestId: string;
  readonly body: unknown;
  readonly now: Date;
};

export type ExecuteInput = {
  readonly db: AuthorityDb;
  readonly requestId: string;
  readonly body: unknown;
  readonly now: Date;
  readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
};

export type CancelInput = {
  readonly db: AuthorityDb;
  readonly taskId: string;
  readonly body: unknown;
  readonly now: Date;
};

export type RetryInput = {
  readonly db: AuthorityDb;
  readonly sourceRequestId: string;
  readonly body: unknown;
  readonly now: Date;
};

export function decideDashboardRequest(input: DecideInput): DashboardDecision {
  const parsed = parseAuthorityDecision(input.body);
  if (parsed.receipt.request_id !== input.requestId) {
    throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
  }
  new ControlPlane(input.db).decide(parsed.receipt, input.now);
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: input.requestId,
    decision: parsed.receipt.decision,
    state: parsed.receipt.decision === "approve" ? "approved" : "rejected",
  };
}

export async function executeDashboardRequest(input: ExecuteInput): Promise<DashboardExecution> {
  parseExecuteRequest(input.body);
  const executed = await new ApprovedCommandExecutor(
    input.db,
    resolve(".jarvis-backups"),
    resolve("state"),
    {},
    () => input.now,
    undefined,
    undefined,
    input.memoryLifecycle,
  ).execute(input.requestId, "dashboard-approved-executor", input.now);
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    execution: executionBody(executed),
  };
}

export function stageDashboardCancel(input: CancelInput): StoredControlCommand {
  const parsed = parseCancelRequest(input.body);
  const graph = new LoopGraph(input.db);
  assertCancelTarget(graph, input.taskId, parsed.run_id);
  return new ControlPlane(input.db).stage(cancelCommand(parsed, input.taskId, input.now), input.now);
}

export function stageDashboardRetry(input: RetryInput): StoredControlCommand {
  const parsed = parseRetryRequest(input.body);
  const source = new ControlPlane(input.db).list().find((item) => item.request_id === input.sourceRequestId);
  if (source === undefined || source.state !== "failed" || controlActionDescriptor(source.action)?.executable !== true) {
    throw new JarvisError("RETRY_NOT_ALLOWED");
  }
  return new ControlPlane(input.db).stage(retryCommand(source, parsed, input.now), input.now);
}

function executionBody(executed: ApprovedExecutionResult): DashboardExecution["execution"] {
  if (executed.failure_code === undefined) {
    return { request_id: executed.request_id, action: executed.action, state: executed.state };
  }
  return {
    request_id: executed.request_id,
    action: executed.action,
    state: executed.state,
    failure_code: executed.failure_code,
  };
}

function assertCancelTarget(graph: LoopGraph, taskId: string, runId: string): void {
  const listed = graph.list();
  if (!listed.some((run) => inputTaskId(run) === taskId)) {
    throw new JarvisError("TASK_NOT_FOUND");
  }
  const run = readRun(graph, runId);
  if (run === undefined || inputTaskId(run) !== taskId || !isActive(run)) {
    throw new JarvisError("CONTROL_STATE_CONFLICT");
  }
}

function isActive(run: StoredWorkflowRun): boolean {
  return !TERMINAL_STATES.has(run.state);
}

function readRun(graph: LoopGraph, runId: string): StoredWorkflowRun | undefined {
  try {
    return graph.get(runId);
  } catch (error) {
    if (error instanceof JarvisError && error.code === "WORKFLOW_NOT_FOUND") return undefined;
    throw error;
  }
}

function inputTaskId(run: StoredWorkflowRun): string | undefined {
  if (typeof run.input !== "object" || run.input === null || Array.isArray(run.input)) return undefined;
  const taskId = Reflect.get(run.input, "task_id");
  return typeof taskId === "string" ? taskId : undefined;
}

function cancelCommand(
  parsed: ReturnType<typeof parseCancelRequest>,
  taskId: string,
  now: Date,
): ControlCommandRequestInput {
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: parsed.request_id,
    action: "workflow.cancel",
    action_level: 3,
    target: { environment: "local", run_id: parsed.run_id, task_id: taskId },
    args: { run_id: parsed.run_id, reason: parsed.reason, task_id: taskId },
    reversible: true,
    requested_by: REQUESTED_BY,
    requested_at: now.toISOString(),
    expires_at: expiresAt(now),
    nonce: parsed.nonce,
  };
}

function retryCommand(
  source: StoredControlCommand,
  parsed: ReturnType<typeof parseRetryRequest>,
  now: Date,
): ControlCommandRequestInput {
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: parsed.request_id,
    action: source.action,
    action_level: source.action_level,
    target: source.target,
    args: source.args,
    reversible: source.reversible,
    requested_by: REQUESTED_BY,
    requested_at: now.toISOString(),
    expires_at: expiresAt(now),
    nonce: parsed.nonce,
  };
}

function expiresAt(now: Date): string {
  return new Date(now.getTime() + REQUEST_TTL_MS).toISOString();
}
