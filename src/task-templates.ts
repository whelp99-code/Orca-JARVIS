import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { parseTaskExecutionPlan, type TaskExecutionPlan } from "./task-execution-plan.js";
import { TASK_REPORT_PROGRAM_V1 } from "./task-template-report.js";
import { parseRequest } from "./team-proposal-input.js";
import type { TeamProposalRequestV1, TeamTaskRequirements } from "./team-proposal.js";

type FileScope = { readonly path: string; readonly access: "read" | "write" };
type Check = TaskExecutionPlan["verification"][number];
const definitions = [
  { id: "code-fix", revision: 1, work_type: "development", sections: [],
    constraint: "Change only approved files; stop on changed input, failed checks or lost authority.",
    evidence: "Required checks and independent verification pass; publish the verified result commit." },
  { id: "incident-report", revision: 1, work_type: "analysis", sections: ["observations", "hypotheses", "proposed_actions", "limitations"],
    constraint: "Write one JSON diagnosis report; source files stay read-only. This report does not resolve the incident.",
    evidence: "Report sections and exact source quotations pass verification; semantic conclusions require review." },
  { id: "technical-review", revision: 1, work_type: "analysis", sections: ["findings", "recommendations", "limitations"],
    constraint: "Write one JSON technical review; reviewed sources stay read-only. Recommendations grant no execution authority.",
    evidence: "Report sections and exact source quotations pass verification; semantic conclusions require review." },
] as const;
const invalid = (): never => { throw new JarvisError("TASK_TEMPLATE_INVALID"); };
function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return invalid();
  return value as Record<string, any>;
}
function definition(id: unknown, revision: unknown) {
  const found = definitions.find(item => item.id === id && item.revision === revision);
  if (!found) return invalid();
  return { ...found, report_program: found.id === "code-fix" ? null : TASK_REPORT_PROGRAM_V1 };
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export function taskTemplateCatalog() {
  return definitions.map(item => { const value = definition(item.id, item.revision);
    return { ...structuredClone(value), definition_digest: digest(value) }; });
}
export interface TaskTemplateBinding {
  readonly schema_version: 1;
  readonly template_id: string;
  readonly revision: 1;
  readonly definition_digest: string;
  readonly files: readonly FileScope[];
  readonly verification: readonly Check[];
}

function validatedScope(files: unknown, verification: unknown) {
  if (!Array.isArray(files)) return invalid();
  const scoped = files.map(value => exact(value, ["path", "access"]));
  try {
    const plan = parseTaskExecutionPlan({ schema_version: 2, mode: "verified_git_commit", provider: "claude",
      run_id: "template", task_id: "template", task_spec_digest: `sha256:${"0".repeat(64)}`,
      repository: { root: "/template", baseline_commit: "0".repeat(40) },
      publication: { ref: "refs/heads/codex/template", repository_identity: `sha256:${"0".repeat(64)}` },
      files: scoped.map(file => ({ ...file, before_digest: `sha256:${"0".repeat(64)}` })), network: "deny",
      verification, limits: { timeout_ms: 60000, max_output_bytes: 65536 } });
    return { files: plan.files.map(({ path, access }) => ({ path, access })), verification: plan.verification };
  } catch { return invalid(); }
}

function reportCheck(value: ReturnType<typeof definition>, files: readonly FileScope[]): Check {
  const sources = files.filter(file => file.access === "read").map(file => file.path);
  const outputs = files.filter(file => file.access === "write");
  if (sources.length < 1 || outputs.length !== 1) return invalid();
  return { id: "template-report-v1", argv: ["node", "-e", TASK_REPORT_PROGRAM_V1, "--", outputs[0]!.path,
    value.id, JSON.stringify(value.sections), JSON.stringify(sources)], cwd: ".", expected_exit: 0 };
}

export function parseTaskTemplateBinding(input: unknown): TaskTemplateBinding {
  const binding = exact(input, ["schema_version", "template_id", "revision", "definition_digest", "files", "verification"]);
  const value = definition(binding.template_id, binding.revision);
  if (binding.schema_version !== 1 || binding.definition_digest !== digest(value)) return invalid();
  const scope = validatedScope(binding.files, binding.verification);
  if (value.id !== "code-fix") {
    const required = reportCheck(value, scope.files);
    if (!scope.verification.some(check => canonicalize(check) === canonicalize(required))) return invalid();
  }
  return { schema_version: 1, template_id: value.id, revision: 1, definition_digest: digest(value), ...scope };
}

/** Compile a proposal and signed-workflow binding; this does not stage or approve a task. */
export function compileTaskTemplate(input: unknown): { task_template: TaskTemplateBinding; proposal_request: TeamProposalRequestV1 } {
  const request = exact(input, ["template_id", "revision", "objective", "files", "verification"]);
  const value = definition(request.template_id, request.revision);
  if (!Array.isArray(request.verification) || !Array.isArray(request.files)) return invalid();
  const files = request.files.map(file => exact(file, ["path", "access"])) as FileScope[];
  const verification = value.id === "code-fix" ? request.verification : [reportCheck(value, files), ...request.verification];
  const task_template = parseTaskTemplateBinding({ schema_version: 1, template_id: value.id, revision: 1,
    definition_digest: digest(value), files, verification });
  const proposal_request: TeamProposalRequestV1 = { schema_version: 1, objective: request.objective,
    work_type: value.work_type, constraints: [value.constraint], completion_evidence: [value.evidence] };
  parseRequest(proposal_request);
  return { task_template, proposal_request };
}

/** Called at workflow approval validation as well as execution; optional only for historical generic tasks. */
export function assertTaskTemplateRequirements(fields: Record<string, unknown>, requirements?: TeamTaskRequirements): void {
  if (!Object.hasOwn(fields, "task_template")) return;
  const binding = parseTaskTemplateBinding(fields.task_template);
  const value = definition(binding.template_id, binding.revision);
  if (!requirements || requirements.work_type !== value.work_type || !requirements.constraints.includes(value.constraint)
    || !requirements.completion_evidence.includes(value.evidence)) return invalid();
}

export function assertTaskTemplatePlan(fields: Record<string, unknown>, plan: TaskExecutionPlan): void {
  if (!Object.hasOwn(fields, "task_template")) return;
  const binding = parseTaskTemplateBinding(fields.task_template);
  const scope = plan.files.map(({ path, access }) => ({ path, access })).sort((a, b) => a.path.localeCompare(b.path));
  const expected = [...binding.files].sort((a, b) => a.path.localeCompare(b.path));
  if (plan.schema_version !== 2 || canonicalize(scope) !== canonicalize(expected)
    || binding.verification.some(required => !plan.verification.some(check => canonicalize(check) === canonicalize(required)))) {
    throw new JarvisError("TASK_TEMPLATE_PLAN_MISMATCH");
  }
}
