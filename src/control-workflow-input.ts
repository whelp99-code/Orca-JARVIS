import { JarvisError } from "./db.js";
import type { WorkflowAdvanceInput, WorkflowRunInput } from "./loopgraph.js";
import { assertWorkflowTaskSpec } from "./task-spec.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new JarvisError("WORKFLOW_INPUT_INVALID");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new JarvisError("WORKFLOW_INPUT_INVALID");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new JarvisError("WORKFLOW_INPUT_INVALID");
  return Number(value);
}
export function controlWorkflowRunInput(args: Readonly<Record<string, unknown>>): WorkflowRunInput {
  const budget = record(args.budget);
  const workflow = {
    run_id: text(args.run_id), loop_id: text(args.loop_id), correlation_id: text(args.correlation_id),
    input: args.input,
    budget: {
      max_steps: integer(budget.max_steps),
      max_attempts_per_node: integer(budget.max_attempts_per_node),
      deadline: text(budget.deadline),
    },
  };
  assertWorkflowTaskSpec(workflow);
  return workflow;
}
export function controlWorkflowAdvanceInput(
  args: Readonly<Record<string, unknown>>,
): WorkflowAdvanceInput {
  const evidence = args.evidence_digest;
  if (evidence !== undefined && typeof evidence !== "string") {
    throw new JarvisError("WORKFLOW_ADVANCE_INVALID");
  }
  return {
    run_id: text(args.run_id), outcome: text(args.outcome), output: args.output,
    ...(evidence === undefined ? {} : { evidence_digest: evidence }),
  };
}
