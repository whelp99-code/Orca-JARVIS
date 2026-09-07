import { isAbsolute, normalize } from "node:path";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

interface TaskExecutionPlanBase {
  readonly run_id: string;
  readonly task_id: string;
  readonly task_spec_digest: string;
  readonly provider: "codex" | "claude";
  readonly repository: { readonly root: string; readonly baseline_commit: string };
  readonly files: readonly { readonly path: string; readonly access: "read" | "write"; readonly before_digest: string | null }[];
  readonly network: "deny";
  readonly limits: { readonly timeout_ms: number; readonly max_output_bytes: number };
  readonly verification: readonly {
    readonly id: string; readonly argv: readonly string[]; readonly cwd: string; readonly expected_exit: 0;
  }[];
}

export interface TaskExecutionPlanV1 extends TaskExecutionPlanBase {
  readonly schema_version: 1; readonly mode: "isolated_candidate";
}
export interface TaskExecutionPlanV2 extends TaskExecutionPlanBase {
  readonly schema_version: 2; readonly mode: "verified_git_commit";
  readonly publication: { readonly ref: string; readonly repository_identity: string };
}
export type TaskExecutionPlan = TaskExecutionPlanV1 | TaskExecutionPlanV2;

function invalid(): never { throw new JarvisError("TASK_EXECUTION_PLAN_INVALID"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= max
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function digest(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function integer(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function relativePath(value: unknown): value is string {
  return text(value) && !isAbsolute(value) && !["\\", "*", "?", "[", "]", "{", "}"].some(token => value.includes(token))
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

/** Validate the signed shape; this does not certify a provider or grant filesystem access. */
export function parseTaskExecutionPlan(value: unknown): TaskExecutionPlan {
  const version = value && typeof value === "object" ? Reflect.get(value, "schema_version") : undefined;
  const plan = record(value, ["schema_version", "run_id", "task_id", "task_spec_digest", "provider", "mode",
    "repository", "files", "network", "limits", "verification", ...(version === 2 ? ["publication"] : [])]);
  if ((version !== 1 && version !== 2) || !text(plan.run_id, 160) || !text(plan.task_id, 160) || !digest(plan.task_spec_digest)
    || (plan.provider !== "codex" && plan.provider !== "claude") || plan.mode !== (version === 2 ? "verified_git_commit" : "isolated_candidate")
    || plan.network !== "deny") return invalid();
  if (version === 2) {
    const publication = record(plan.publication, ["ref", "repository_identity"]);
    if (!digest(publication.repository_identity) || typeof publication.ref !== "string"
      || !/^refs\/heads\/codex\/[a-z0-9][a-z0-9._-]{0,79}$/.test(publication.ref)
      || publication.ref.includes("..") || publication.ref.endsWith(".") || publication.ref.endsWith(".lock")) return invalid();
  } else if (version !== 1) return invalid();
  const repository = record(plan.repository, ["root", "baseline_commit"]);
  if (!text(repository.root, 4096) || !isAbsolute(repository.root) || normalize(repository.root) !== repository.root
    || repository.root === "/" || typeof repository.baseline_commit !== "string"
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(repository.baseline_commit)) return invalid();
  const limits = record(plan.limits, ["timeout_ms", "max_output_bytes"]);
  if (!integer(limits.timeout_ms, 1000, 600_000) || !integer(limits.max_output_bytes, 1024, 1_048_576)) return invalid();
  if (!Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > 128) return invalid();
  const paths = new Set<string>();
  let writable = false;
  for (const value of plan.files) {
    const file = record(value, ["path", "access", "before_digest"]);
    if (!relativePath(file.path) || paths.has(file.path) || (file.access !== "read" && file.access !== "write")
      || !(digest(file.before_digest) || (file.before_digest === null && file.access === "write"))) return invalid();
    paths.add(file.path);
    writable ||= file.access === "write";
  }
  if (!writable) return invalid();
  // A file cannot simultaneously be the parent directory of another declared file.
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) if (paths.has(parts.slice(0, index).join("/"))) return invalid();
  }
  if (!Array.isArray(plan.verification) || plan.verification.length < 1 || plan.verification.length > 8) return invalid();
  const ids = new Set<string>();
  for (const value of plan.verification) {
    const check = record(value, ["id", "argv", "cwd", "expected_exit"]);
    if (!text(check.id, 80) || ids.has(check.id) || check.expected_exit !== 0
      || !(check.cwd === "." || relativePath(check.cwd)) || !Array.isArray(check.argv)
      || check.argv.length < 1 || check.argv.length > 64 || !check.argv.every(arg => text(arg, 4096))) return invalid();
    ids.add(check.id);
  }
  return JSON.parse(canonicalize(plan)) as TaskExecutionPlan;
}

export function taskExecutionPlanDigest(plan: TaskExecutionPlan): string {
  return `sha256:${createHash("sha256").update(canonicalize(parseTaskExecutionPlan(plan))).digest("hex")}`;
}

export function validateTaskExecutionAction(input: {
  target: Record<string, unknown>; args: Record<string, unknown>;
}): void {
  const target = record(input.target, ["environment", "run_id", "task_id"]);
  const args = record(input.args, ["plan", "execution_plan_digest"]);
  const plan = parseTaskExecutionPlan(args.plan);
  if (target.environment !== "local" || target.run_id !== plan.run_id || target.task_id !== plan.task_id
    || args.execution_plan_digest !== taskExecutionPlanDigest(plan)) return invalid();
}
