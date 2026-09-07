import type { TaskExecutionPlanV2 } from "../../src/task-execution-plan.js";
import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import type { PreparedDashboardTaskExecution } from "../../src/dashboard/task-execution-service.js";

export const HASH = `sha256:${"a".repeat(64)}`;
export const AT = "2026-09-08T00:00:00.000Z";
export const PLAN: TaskExecutionPlanV2 = { schema_version: 2, mode: "verified_git_commit", run_id: "run-1", task_id: "task-1",
  task_spec_digest: HASH, provider: "claude", repository: { root: "/repo", baseline_commit: "a".repeat(40) },
  publication: { ref: "refs/heads/codex/result", repository_identity: HASH }, network: "deny",
  files: [{ path: "answer.mjs", access: "write", before_digest: HASH }], limits: { timeout_ms: 180000, max_output_bytes: 262144 },
  verification: [{ id: "check-1", argv: ["node", "--check", "answer.mjs"], cwd: ".", expected_exit: 0 }] };
export const PREVIEW: PreparedDashboardTaskExecution = { schema_version: 1, plan: PLAN, execution_plan_digest: HASH,
  repository: { state: "checked", execution_plan_digest: HASH, baseline_commit: PLAN.repository.baseline_commit, total_bytes: 25,
    snapshot_digest: HASH, files: [{ path: "answer.mjs", access: "write", digest: HASH, bytes: 25, executable: false }] } };
export const EMPTY: DashboardTaskExecution = { schema_version: 1, task_id: "task-1", requests: [],
  runs: [{ run_id: "run-1", state: "running", updated_at: AT }], truncated: { runs: false, requests: false } };
export const PENDING: DashboardTaskExecution["requests"][number] = { plan: PLAN, command_digest: HASH, expires_at: AT,
  request: { request_id: "request-ui", action: "task.execute", action_level: 3, requested_at: AT,
    requested_by: "jarvis-control-center", summary: "Execute the reviewed task plan", state: "pending", retry_status: "not_allowed" }, completion: null };
export const COMPLETION: NonNullable<DashboardTaskExecution["requests"][number]["completion"]> = {
  schema_version: 1, state: "completed", completion_id: "task-completion:fixture", request_id: "request-ui", fence: 1,
  command_digest: HASH, run_id: "run-1", publication_id: "publication-fixture", publication_digest: HASH,
  verification_id: "independent-verifier-fixture", artifact_id: "artifact-fixture", candidate_digest: HASH,
  commit: "b".repeat(40), tree: "c".repeat(40), ref: PLAN.publication.ref, graph_digest: HASH, from_node: "observe",
  prior_attempts: 0, node_attempt: 1, observed_at: AT, completed_at: AT,
};
export const SIGNED_RECEIPT = { schema_version: 1, receipt_id: "receipt-ui", request_id: "request-ui", decision: "approve",
  command_digest: HASH, signer_principal_id: "fixture-operator", authenticated_session_id: "fixture-session", key_id: "fixture-key",
  algorithm: "Ed25519", issued_at: AT, not_before: AT, expires_at: AT, nonce: "receipt-nonce", max_uses: 1, status: "issued", signature: "fixture" };
