import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./jarvis-error.js";
import type { WorkflowRunInput } from "./loopgraph.js";
import type { TeamMemberProposal, TeamProposalResultV1, TeamTaskRequirements } from "./team-proposal.js";
import { parseRequest } from "./team-proposal-input.js";
import { assertTaskTemplateRequirements } from "./task-templates.js";
import { parseTaskRoutingBinding, type TaskRoutingBinding } from "./task-routing-binding.js";

/** Declared work requirements; member scopes do not grant filesystem or execution permissions. */
export interface TaskSpecV1 {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly objective: string;
  readonly requirements: TeamTaskRequirements;
  readonly assignments: readonly TeamMemberProposal[];
  readonly budget: WorkflowRunInput["budget"];
  readonly routing?: TaskRoutingBinding;
}

export function taskSpecDigest(spec: TaskSpecV1): string {
  return `sha256:${createHash("sha256").update(canonicalize(spec)).digest("hex")}`;
}

export function createTaskSpec(
  taskId: string,
  proposal: Extract<TeamProposalResultV1, { status: "ready" }>,
  budget: WorkflowRunInput["budget"],
): TaskSpecV1 {
  return {
    schema_version: 1, task_id: taskId, objective: proposal.objective,
    requirements: proposal.requirements, assignments: proposal.members, budget,
  };
}

/** Check the specification at the approved workflow boundary without rewriting historical runs. */
export function assertWorkflowTaskSpec(workflow: WorkflowRunInput): void {
  const input = workflow.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const fields = input as Record<string, unknown>;
  if (!Object.hasOwn(fields, "task_spec") && !Object.hasOwn(fields, "task_spec_digest")
    && !Object.hasOwn(fields, "task_template")) return;
  try { assertBinding(fields, workflow.budget); }
  catch { throw new JarvisError("TASK_SPEC_BINDING_INVALID"); }
}

function assertBinding(fields: Record<string, unknown>, budget: WorkflowRunInput["budget"]): void {
  const spec = fields.task_spec as TaskSpecV1 | undefined;
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || spec.schema_version !== 1
    || Object.keys(spec).sort().join(",") !== ["assignments", "budget", "objective", "requirements", "schema_version", "task_id",
      ...(Object.hasOwn(spec, "routing") ? ["routing"] : [])].sort().join(",")
    || !spec.requirements || !Array.isArray(spec.requirements.constraints)
    || !Array.isArray(spec.requirements.completion_evidence) || spec.requirements.completion_evidence.length === 0
    || !Array.isArray(spec.assignments) || spec.assignments.length === 0
    || spec.task_id !== fields.task_id || spec.objective !== fields.objective
    || canonicalize(spec.assignments) !== canonicalize(fields.members)
    || canonicalize(spec.budget) !== canonicalize(budget)
    || fields.task_spec_digest !== taskSpecDigest(spec)) {
    throw new JarvisError("TASK_SPEC_BINDING_INVALID");
  }
  if (Object.keys(spec.requirements).sort().join(",") !== "completion_evidence,constraints,work_type") {
    throw new JarvisError("TASK_SPEC_BINDING_INVALID");
  }
  parseRequest({ schema_version: 1, objective: spec.objective, ...spec.requirements });
  if (Object.hasOwn(spec, "routing")) parseTaskRoutingBinding(spec.routing, spec.objective);
  assertTaskTemplateRequirements(fields, spec.requirements);
}
