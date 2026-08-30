import { canonicalize } from "./canonical.js";
import {
  closedInteger,
  closedJsonRecord,
  closedRecord,
  closedText,
  task25Invalid,
  task25Timestamp,
  type ClosedJson,
} from "./task25-closed-input.js";
export type ParsedRecommendationWorkflowRequest = {
  readonly recommendationId: string;
  readonly actionRank: number;
  readonly principalId: string;
  readonly sessionId: string;
  readonly repository: string;
  readonly environment: "local";
  readonly goal: string;
  readonly workflowArgs: { readonly [key: string]: ClosedJson };
  readonly budget: {
    readonly max_steps: number;
    readonly max_attempts_per_node: number;
    readonly deadline: string;
  };
};
function workflowArgs(value: unknown): { readonly [key: string]: ClosedJson } {
  const parsed = closedJsonRecord(value);
  if (Buffer.byteLength(canonicalize(parsed), "utf8") > 4096) return task25Invalid();
  return parsed;
}
export function parseRecommendationWorkflowRequest(value: unknown): ParsedRecommendationWorkflowRequest {
  const input = closedRecord(value, [
    "schema_version", "recommendation_id", "action_rank", "requested_by",
    "target", "workflow", "budget", "deadline",
  ]);
  if (input["schema_version"] !== 1) return task25Invalid();
  const requested = closedRecord(input["requested_by"], ["principal_id", "authenticated_session_id"]);
  const target = closedRecord(input["target"], ["repository", "environment"]);
  const workflow = closedRecord(input["workflow"], ["goal", "args"]);
  const budget = closedRecord(input["budget"], ["max_steps", "max_attempts_per_node"]);
  const deadline = task25Timestamp(input["deadline"]);
  if (target["environment"] !== "local") return task25Invalid();
  return {
    recommendationId: closedText(input["recommendation_id"], 80),
    actionRank: closedInteger(input["action_rank"], 1, 32),
    principalId: closedText(requested["principal_id"], 128),
    sessionId: closedText(requested["authenticated_session_id"], 128),
    repository: closedText(target["repository"], 256), environment: "local",
    goal: closedText(workflow["goal"], 4096), workflowArgs: workflowArgs(workflow["args"]),
    budget: {
      max_steps: closedInteger(budget["max_steps"], 1, 100),
      max_attempts_per_node: closedInteger(budget["max_attempts_per_node"], 1, 10), deadline,
    },
  };
}
export function parseStagedRecommendationWorkflow(args: Readonly<Record<string, unknown>>): ParsedRecommendationWorkflowRequest {
  const input = closedRecord(args["input"]); const budget = closedRecord(args["budget"]);
  return {
    recommendationId: closedText(input["recommendation_id"]),
    actionRank: closedInteger(input["action_rank"], 1, 32),
    principalId: closedText(input["requested_by_principal_id"]),
    sessionId: closedText(input["authenticated_session_id"]),
    repository: closedText(input["target_repository"]), environment: "local",
    goal: closedText(input["goal"], 4096), workflowArgs: workflowArgs(input["workflow_args"]),
    budget: {
      max_steps: closedInteger(budget["max_steps"], 1, 100),
      max_attempts_per_node: closedInteger(budget["max_attempts_per_node"], 1, 10),
      deadline: task25Timestamp(budget["deadline"]),
    },
  };
}
export function stagedRecommendationWorkflowInput(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return closedRecord(args["input"]);
}
