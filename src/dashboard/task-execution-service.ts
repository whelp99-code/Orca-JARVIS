import { performance } from "node:perf_hooks";
import { parseTaskWorkLineage, type TaskWorkLineage } from "../task-work-lineage.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { LoopGraph } from "../loopgraph.js";
import { candidateHash } from "../task-candidate-artifact-codec.js";
import { taskCompletionWorkflow } from "../task-completion-workflow.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest, type TaskExecutionPlanV2 } from "../task-execution-plan.js";
import { assertTaskExecutionBinding, stageTaskExecution } from "../task-execution-staging.js";
import { inspectTaskExecutionRepository } from "../task-execution-workspace.js";
import { TaskPublicationGit } from "../task-publication-git.js";
import { taskExecutionReadiness } from "../task-execution-runtime.js";
import { TASK_FILE_LIMITS } from "../task-execution-limits.js";
import { assertRegisteredTaskPlan } from "../task-executor-plan.js";

export interface PrepareTaskExecutionRequest {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly provider: "claude" | "codex";
  readonly repository_root: string;
  readonly files: readonly { readonly path: string; readonly access: "read" | "write"; readonly exists: boolean }[];
  readonly publication_ref: string;
  readonly limits: TaskExecutionPlanV2["limits"];
  readonly verification: TaskExecutionPlanV2["verification"];
}
export interface StageDashboardTaskExecutionRequest {
  readonly work_lineage?: TaskWorkLineage;
  readonly schema_version: 1;
  readonly request_id: string;
  readonly nonce: string;
  readonly plan: TaskExecutionPlanV2;
}
const ZERO = `sha256:${"0".repeat(64)}`;
const invalid = (): never => { throw new JarvisError("TASK_EXECUTION_INPUT_INVALID"); };
function exact(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== keys.sort().join(",")) return invalid();
  return value as Record<string, any>;
}
function initialPlan(db: AuthorityDb, taskId: string, body: unknown): TaskExecutionPlanV2 {
  const request = exact(body, ["schema_version", "run_id", "provider", "repository_root", "files", "publication_ref", "limits", "verification"]);
  if (request.schema_version !== 1 || typeof request.run_id !== "string" || !Array.isArray(request.files)) return invalid();
  const files = request.files.map(value => {
    const file = exact(value, ["path", "access", "exists"]);
    if (typeof file.exists !== "boolean") return invalid();
    return { path: file.path, access: file.access, before_digest: file.exists ? ZERO : null };
  });
  // Validate all client fields before even looking up a run, then replace only server-owned bindings.
  const template = parseTaskExecutionPlan({ schema_version: 2, mode: "verified_git_commit", run_id: request.run_id,
    task_id: taskId, task_spec_digest: ZERO, provider: request.provider,
    repository: { root: request.repository_root, baseline_commit: "0".repeat(40) }, files, network: "deny",
    publication: { ref: request.publication_ref, repository_identity: ZERO }, limits: request.limits, verification: request.verification });
  const run = new LoopGraph(db).get(template.run_id);
  const input = run.input as Record<string, unknown> | null;
  return parseTaskExecutionPlan({ ...template, task_spec_digest: input?.task_spec_digest }) as TaskExecutionPlanV2;
}

function current(db: AuthorityDb, plan: TaskExecutionPlanV2, now: Date): void {
  assertTaskExecutionBinding(db, plan, now);
  taskCompletionWorkflow(db, plan.run_id, now);
  assertRegisteredTaskPlan(plan);
}

/** No command/approval writes, model invocation, or file content in the returned preview. */
export async function prepareDashboardTaskExecution(db: AuthorityDb, taskId: string, body: unknown,
  clock: () => Date = () => new Date()) {
  const plan = initialPlan(db, taskId, body);
  const started = performance.now();
  const check = () => {
    current(db, plan, clock());
    const remaining = Math.floor(30_000 - (performance.now() - started));
    if (remaining <= 0) throw new JarvisError("TASK_EXECUTION_PREPARATION_TIMEOUT");
    return remaining;
  };
  check();
  const git = await TaskPublicationGit.open(plan.repository.root, check, clock().toISOString(), true);
  try {
    const baseline = (await git.run(["rev-parse", "--verify", "HEAD"])).toString("utf8").trimEnd();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) return invalid();
    if (await git.readRef(plan.publication.ref)) throw new JarvisError("TASK_PUBLICATION_REF_EXISTS");
    const raw = await git.run(["ls-tree", "-z", baseline, "--", ...plan.files.map(file => file.path)]);
    const entries = new Map<string, { oid: string; executable: boolean }>();
    for (const row of raw.toString("utf8").split("\0").filter(Boolean)) {
      const entry = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(row);
      if (!entry || entries.has(entry[3]!) || !plan.files.some(file => file.path === entry[3])) {
        throw new JarvisError("TASK_REPOSITORY_BASELINE_CHANGED");
      }
      entries.set(entry[3]!, { oid: entry[2]!, executable: entry[1] === "100755" });
    }
    let total = 0;
    const files: TaskExecutionPlanV2["files"][number][] = [];
    for (const file of plan.files) {
      check();
      const entry = entries.get(file.path);
      if (file.before_digest === null) {
        if (entry) throw new JarvisError("TASK_REPOSITORY_BASELINE_CHANGED");
        files.push(file);
      } else {
        if (!entry) throw new JarvisError("TASK_REPOSITORY_BASELINE_CHANGED");
        const bytes = await git.run(["cat-file", "blob", entry.oid], undefined, TASK_FILE_LIMITS.max_file_bytes);
        total += bytes.length;
        if (total > TASK_FILE_LIMITS.max_total_bytes) throw new JarvisError("TASK_REPOSITORY_INPUT_OVERSIZE");
        files.push({ ...file, before_digest: candidateHash(bytes) });
      }
    }
    const prepared = parseTaskExecutionPlan({ ...plan, repository: { root: plan.repository.root, baseline_commit: baseline },
      files, publication: { ...plan.publication, repository_identity: git.identity } }) as TaskExecutionPlanV2;
    // Leave room for request identity/envelope in the shared 64 KiB POST boundary.
    if (Buffer.byteLength(JSON.stringify(prepared)) > 60 * 1024) throw new JarvisError("TASK_EXECUTION_PLAN_TOO_LARGE");
    const repository = await inspectTaskExecutionRepository(prepared, async () => ({ root: plan.repository.root,
      commit: (await git.run(["rev-parse", "--verify", "HEAD"])).toString("utf8").trimEnd() }),
    { identity: async () => git.identity, check });
    if (repository.files.some(file => file.digest !== null && file.executable !== entries.get(file.path)?.executable)) {
      throw new JarvisError("TASK_REPOSITORY_FILE_CHANGED");
    }
    check();
    return { schema_version: 1 as const, plan: prepared, execution_plan_digest: taskExecutionPlanDigest(prepared), repository };
  } finally { await git.close(); }
}

export async function stageDashboardTaskExecution(db: AuthorityDb, taskId: string, body: unknown,
  clock: () => Date = () => new Date()) {
  const hasLineage = body !== null && typeof body === "object" && Object.hasOwn(body, "work_lineage");
  const value = exact(body, ["schema_version", "request_id", "nonce", "plan", ...(hasLineage ? ["work_lineage"] : [])]);
  if (value.schema_version !== 1 || ![value.request_id, value.nonce].every(item => typeof item === "string"
    && item.trim().length > 0 && item.length <= 160
    && [...item].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))) return invalid();
  const plan = parseTaskExecutionPlan(value.plan);
  if (plan.schema_version !== 2 || plan.task_id !== taskId) return invalid();
  current(db, plan, clock());
  const preview = await prepareDashboardTaskExecution(db, taskId, { schema_version: 1, run_id: plan.run_id,
    provider: plan.provider, repository_root: plan.repository.root, publication_ref: plan.publication.ref,
    limits: plan.limits, verification: plan.verification,
    files: plan.files.map(file => ({ path: file.path, access: file.access, exists: file.before_digest !== null })) }, clock);
  if (preview.execution_plan_digest !== taskExecutionPlanDigest(plan)) throw new JarvisError("TASK_EXECUTION_PREVIEW_STALE");
  current(db, plan, clock());
  return stageTaskExecution(db, { request_id: value.request_id, nonce: value.nonce,
    requested_by: "jarvis-control-center", plan,
    ...(hasLineage ? { work_lineage: parseTaskWorkLineage(value.work_lineage) } : {}) }, clock());
}

export type PreparedDashboardTaskExecution = Awaited<ReturnType<typeof prepareDashboardTaskExecution>>;

export async function checkDashboardTaskExecution(db: AuthorityDb, taskId: string, body: unknown, clock: () => Date) {
  const value = exact(body, ["schema_version", "plan"]);
  const plan = parseTaskExecutionPlan(value.plan);
  if (value.schema_version !== 1 || plan.schema_version !== 2 || plan.task_id !== taskId) return invalid();
  assertTaskExecutionBinding(db, plan, clock());
  const readiness = await taskExecutionReadiness(db, plan, clock);
  assertTaskExecutionBinding(db, plan, clock());
  return { schema_version: 1 as const, task_id: taskId, run_id: plan.run_id,
    execution_plan_digest: taskExecutionPlanDigest(plan), ...readiness };
}
export type DashboardTaskReadiness = Awaited<ReturnType<typeof checkDashboardTaskExecution>>;
