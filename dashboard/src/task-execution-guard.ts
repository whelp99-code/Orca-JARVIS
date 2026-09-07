import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import type { PreparedDashboardTaskExecution } from "../../src/dashboard/task-execution-service.js";
import type { TaskExecutionPlan } from "../../src/task-execution-plan.js";

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
const oid = (v: unknown) => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const list = (v: unknown, min: number, max: number): v is any[] => Array.isArray(v) && v.length >= min && v.length <= max;
const states = ["pending", "approved", "rejected", "claimed", "completed", "failed", "uncertain", "cancelled"];

/** Response validation only; browser fields never grant execution authority. */
export function isTaskExecutionPlan(v: unknown): v is TaskExecutionPlan {
  if (!object(v) || !text(v.run_id) || !text(v.task_id) || !digest(v.task_spec_digest)
    || !["claude", "codex"].includes(v.provider) || v.network !== "deny"
    || !object(v.repository) || !text(v.repository.root) || !oid(v.repository.baseline_commit)
    || !object(v.limits) || !integer(v.limits.timeout_ms, 1000, 600000) || !integer(v.limits.max_output_bytes, 1024, 1048576)) return false;
  if (v.schema_version === 2) {
    if (v.mode !== "verified_git_commit" || !object(v.publication) || !text(v.publication.ref)
      || !v.publication.ref.startsWith("refs/heads/codex/") || !digest(v.publication.repository_identity)) return false;
  } else if (v.schema_version !== 1 || v.mode !== "isolated_candidate") return false;
  return list(v.files, 1, 128) && v.files.every(file => object(file) && text(file.path)
    && ["read", "write"].includes(file.access) && (digest(file.before_digest) || (file.access === "write" && file.before_digest === null)))
    && list(v.verification, 1, 8) && v.verification.every(check => object(check) && text(check.id)
      && text(check.cwd) && check.expected_exit === 0 && list(check.argv, 1, 64) && check.argv.every(text));
}

export function parsePreparedExecution(v: unknown, taskId: string, runId: string): PreparedDashboardTaskExecution | undefined {
  if (!object(v) || v.schema_version !== 1 || !isTaskExecutionPlan(v.plan) || v.plan.schema_version !== 2
    || v.plan.task_id !== taskId || v.plan.run_id !== runId || !digest(v.execution_plan_digest)
    || !object(v.repository) || v.repository.state !== "checked"
    || v.repository.execution_plan_digest !== v.execution_plan_digest || v.repository.baseline_commit !== v.plan.repository.baseline_commit
    || !digest(v.repository.snapshot_digest) || !integer(v.repository.total_bytes, 0, 16 * 1024 * 1024)
    || !list(v.repository.files, v.plan.files.length, v.plan.files.length)) return undefined;
  const plan = v.plan;
  if (!v.repository.files.every((file, index) => object(file) && file.path === plan.files[index]?.path
    && file.access === plan.files[index]?.access && file.digest === plan.files[index]?.before_digest
    && integer(file.bytes, 0, 4 * 1024 * 1024) && typeof file.executable === "boolean" && !("content" in file))) return undefined;
  return v as PreparedDashboardTaskExecution;
}

export function parseTaskExecution(v: unknown, taskId: string): DashboardTaskExecution | undefined {
  if (!object(v) || v.schema_version !== 1 || v.task_id !== taskId || !list(v.runs, 0, 20) || !list(v.requests, 0, 20)
    || !object(v.truncated) || typeof v.truncated.runs !== "boolean" || typeof v.truncated.requests !== "boolean") return undefined;
  if (!v.runs.every(run => object(run) && text(run.run_id) && text(run.state) && text(run.updated_at))) return undefined;
  if (!v.requests.every(item => {
    if (!object(item) || !object(item.request) || !isTaskExecutionPlan(item.plan) || item.plan.task_id !== taskId
      || !digest(item.command_digest) || !text(item.expires_at)) return false;
    const r = item.request;
    if (!text(r.request_id) || r.action !== "task.execute" || r.action_level !== 3 || !text(r.requested_at)
      || !text(r.requested_by) || !text(r.summary) || !states.includes(r.state) || r.retry_status !== "not_allowed") return false;
    const c = item.completion;
    return c === null || (object(c) && c.schema_version === 1 && c.state === "completed" && r.state === "completed"
      && c.request_id === r.request_id && c.run_id === item.plan.run_id && c.command_digest === item.command_digest
      && item.plan.schema_version === 2 && c.ref === item.plan.publication.ref && oid(c.commit) && oid(c.tree)
      && [c.completion_id, c.publication_id, c.verification_id, c.artifact_id, c.from_node, c.observed_at, c.completed_at].every(text)
      && [c.publication_digest, c.candidate_digest, c.graph_digest].every(digest)
      && integer(c.fence, 1, Number.MAX_SAFE_INTEGER) && integer(c.node_attempt, 1, Number.MAX_SAFE_INTEGER)
      && integer(c.prior_attempts, 0, Number.MAX_SAFE_INTEGER));
  })) return undefined;
  return v as DashboardTaskExecution;
}
