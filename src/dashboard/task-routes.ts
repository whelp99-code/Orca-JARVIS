import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityProbe } from "../capabilities.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { stageDashboardTask } from "./command-service.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import type { ReconcileHub } from "./events.js";
import { writeDashboardJson } from "./http.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import { redactDashboardValue } from "./redaction.js";
import { parseCreateTaskRequest } from "./validation.js";

const TASKS_PATH = "/api/v1/tasks";

const ERROR_STATUS = {
  TASK_ROUTING_BINDING_INVALID: 400,
  TASK_ROUTING_REVIEW_REQUIRED: 409,
  TASK_EXECUTOR_UNREGISTERED: 409,
  TASK_INPUT_INVALID: 400,
  TASK_TEMPLATE_INVALID: 400,
  TASK_SPEC_BINDING_INVALID: 400,
  TEAM_PROPOSAL_INPUT_INVALID: 400,
  VALIDATION_ERROR: 400,
  CONTROL_COMMAND_INVALID: 400,
  PROPOSAL_STALE: 409,
  CONTROL_STATE_CONFLICT: 409,
} as const;

const ERROR_MESSAGE = {
  TASK_ROUTING_BINDING_INVALID: "Invalid task routing binding",
  TASK_ROUTING_REVIEW_REQUIRED: "Routing requires review",
  TASK_EXECUTOR_UNREGISTERED: "Selected executor is not registered",
  TASK_INPUT_INVALID: "Invalid task input",
  TASK_TEMPLATE_INVALID: "Invalid task template",
  TASK_SPEC_BINDING_INVALID: "Invalid task specification binding",
  TEAM_PROPOSAL_INPUT_INVALID: "Invalid team proposal input",
  VALIDATION_ERROR: "Validation error",
  CONTROL_COMMAND_INVALID: "Invalid control command",
  PROPOSAL_STALE: "Proposal digest is stale",
  CONTROL_STATE_CONFLICT: "Control state conflict",
} as const satisfies Record<keyof typeof ERROR_STATUS, string>;

export type TaskRouteInput = {
  readonly db: AuthorityDb;
  readonly path: string;
  readonly response: ServerResponse;
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly body: unknown;
  readonly hub: ReconcileHub;
  readonly clock: () => Date;
  readonly capabilityProbe?: CapabilityProbe;
  readonly planner?: TeamProposalPlanner;
};

export async function tryHandleTaskCreate(input: TaskRouteInput): Promise<boolean> {
  if (input.request.method !== "POST" || input.path !== TASKS_PATH) return false;
  const capabilityProbe = input.capabilityProbe;
  const planner = input.planner;
  if (capabilityProbe === undefined || planner === undefined) return false;
  try {
    const request = parseCreateTaskRequest(input.body);
    const staged = await stageDashboardTask({
      db: input.db,
      capabilityProbe,
      planner,
      now: input.clock(),
      request,
    });
    input.hub.publish(["overview", "tasks", `task:${request.task_id}`, "approvals"]);
    writeDashboardJson(input.response, {
      status: 202,
      requestId: input.requestId,
      body: redactDashboardValue({
        schema_version: DASHBOARD_SCHEMA_VERSION,
        request: staged,
      }),
    });
    return true;
  } catch (error) {
    const mapped = mappedTaskError(error);
    if (mapped === undefined) throw error;
    writeDashboardJson(input.response, {
      status: mapped.status,
      requestId: input.requestId,
      body: {
        schema_version: DASHBOARD_SCHEMA_VERSION,
        error: { code: mapped.code, message: mapped.message, request_id: input.requestId },
      },
    });
    return true;
  }
}

type MappedTaskError = {
  readonly status: (typeof ERROR_STATUS)[keyof typeof ERROR_STATUS];
  readonly code: keyof typeof ERROR_STATUS;
  readonly message: string;
};

function mappedTaskError(error: unknown): MappedTaskError | undefined {
  if (!(error instanceof JarvisError)) return undefined;
  switch (error.code) {
    case "TASK_ROUTING_BINDING_INVALID":
    case "TASK_ROUTING_REVIEW_REQUIRED":
    case "TASK_EXECUTOR_UNREGISTERED":
    case "TASK_INPUT_INVALID":
    case "TASK_TEMPLATE_INVALID":
    case "TASK_SPEC_BINDING_INVALID":
    case "TEAM_PROPOSAL_INPUT_INVALID":
    case "VALIDATION_ERROR":
    case "CONTROL_COMMAND_INVALID":
    case "PROPOSAL_STALE":
    case "CONTROL_STATE_CONFLICT":
      return { status: ERROR_STATUS[error.code], code: error.code, message: ERROR_MESSAGE[error.code] };
    default:
      return undefined;
  }
}
