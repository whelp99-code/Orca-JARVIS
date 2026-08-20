import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../../src/canonical.js";
import {
  ApprovedCommandExecutor,
  ControlPlane,
  LiveSupervisor,
  signCommandApproval,
  type ControlCommandRequestInput,
  type StoredControlCommand,
} from "../../src/index.js";
import { LoopGraph } from "../../src/loopgraph.js";
import type { AuthorityDb } from "../../src/db.js";
import {
  AGENT_INCARNATION,
  AGENT_PROVIDER,
  AGENT_TERMINAL,
  DECISION_KEY_ID,
  DECISION_PRINCIPAL,
  FIXTURE_SESSION,
  IDS,
  KOREAN_OBJECTIVE,
} from "./dashboard-fixture-ids.js";
import type { FixtureEnv } from "./dashboard-fixture-env.js";

const LOOP = "agentops-default";
const TWELVE_HOURS_MS = 12 * 60 * 60_000;
const RECEIPT_MS = 15 * 60_000;

function startCommand(id: string, taskId: string, runId: string, objective: string, now: Date): ControlCommandRequestInput {
  const at = now.toISOString();
  return {
    schema_version: 1,
    request_id: id,
    action: "workflow.start",
    action_level: 2,
    target: { environment: "local", run_id: runId, loop_id: LOOP, correlation_id: taskId, task_id: taskId },
    args: {
      run_id: runId,
      loop_id: LOOP,
      correlation_id: taskId,
      input: { task_id: taskId, objective },
      budget: { max_steps: 8, max_attempts_per_node: 2, deadline: new Date(now.getTime() + TWELVE_HOURS_MS).toISOString() },
    },
    reversible: true,
    requested_by: DECISION_PRINCIPAL,
    requested_at: at,
    expires_at: new Date(now.getTime() + TWELVE_HOURS_MS).toISOString(),
    nonce: `nonce-${id}`,
  };
}

function signed(env: FixtureEnv, staged: StoredControlCommand, now: Date): ReturnType<typeof signCommandApproval> {
  const at = now.toISOString();
  return signCommandApproval({
    schema_version: 1,
    receipt_id: `seed-${staged.request_id}`,
    request_id: staged.request_id,
    decision: "approve",
    command_digest: staged.command_digest,
    signer_principal_id: DECISION_PRINCIPAL,
    authenticated_session_id: `seed-session-${staged.request_id}`,
    key_id: DECISION_KEY_ID,
    algorithm: "Ed25519",
    issued_at: at,
    not_before: at,
    expires_at: new Date(now.getTime() + RECEIPT_MS).toISOString(),
    nonce: `seed-approval-${staged.request_id}`,
    max_uses: 1,
    status: "issued",
  }, createPrivateKey(readFileSync(env.decisionKeyPath, "utf8")));
}

function executor(db: AuthorityDb, env: FixtureEnv, now: Date): ApprovedCommandExecutor {
  return new ApprovedCommandExecutor(db, join(env.tempRoot, "backups"), join(env.tempRoot, "state"), {}, () => now);
}

async function executeStart(env: FixtureEnv, command: ControlCommandRequestInput, now: Date, worker: string): Promise<StoredControlCommand> {
  const control = new ControlPlane(env.db);
  const staged = control.stage(command, now);
  control.decide(signed(env, staged, now), now);
  await executor(env.db, env, now).execute(staged.request_id, worker, now);
  const listed = control.list().find((item) => item.request_id === staged.request_id);
  if (listed === undefined) throw new Error(`missing settled request ${staged.request_id}`);
  return listed;
}

function seedRisk(db: AuthorityDb): void {
  db.db.prepare(
    "INSERT INTO gjc_runtime_status(id, pid, last_heartbeat_at, last_error_code, updated_at) VALUES (1, 1, ?, NULL, ?)",
  ).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
}

function seedAgent(env: FixtureEnv, now: Date): string {
  const binding = new LiveSupervisor(env.db).register({
    worktree: env.worktree,
    provider: AGENT_PROVIDER,
    terminal_id: AGENT_TERMINAL,
    session_id: FIXTURE_SESSION,
    incarnation_id: AGENT_INCARNATION,
    pty_id: "pty-e2e-1",
    worktree_id: "worktree-e2e-1",
    project_id: "e2e-project",
  }, now.toISOString());
  return `sha256:${createHash("sha256").update(canonicalize({
    canonical_path: binding.canonical_path,
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    incarnation_id: binding.incarnation_id,
  })).digest("hex")}`;
}

export async function seedRichOverview(env: FixtureEnv, now: Date): Promise<string> {
  const failed = await executeStart(
    env,
    startCommand(IDS.failedRetry, IDS.failedRetryTask, IDS.failedRetryRun, "Failed retry source", now),
    now,
    "seed-failed-executor",
  );
  if (failed.state !== "failed") throw new Error(`failed retry source required, got ${failed.state}`);
  new LoopGraph(env.db).ensureDefaults(now);
  const korean = await executeStart(
    env,
    startCommand(IDS.koreanRequest, IDS.koreanTask, IDS.koreanRun, KOREAN_OBJECTIVE, now),
    now,
    "dashboard-approved-executor",
  );
  if (korean.state !== "completed") throw new Error(`korean workflow required, got ${korean.state}`);
  const cancellable = await executeStart(
    env,
    startCommand(IDS.cancelRequest, IDS.cancelTask, IDS.cancelRun, "Cancellable active task", now),
    now,
    "dashboard-approved-executor",
  );
  if (cancellable.state !== "completed") throw new Error(`cancel source required, got ${cancellable.state}`);
  const control = new ControlPlane(env.db);
  control.stage(startCommand(IDS.pendingApprove, IDS.pendingApproveTask, IDS.pendingApproveRun, "Approve then execute", now), now);
  control.stage(startCommand(IDS.pendingReject, IDS.pendingRejectTask, IDS.pendingRejectRun, "Reject pending request", now), now);
  control.stage(startCommand(IDS.pendingInvalid, IDS.pendingInvalidTask, IDS.pendingInvalidRun, "Invalid receipt target", now), now);
  seedRisk(env.db);
  return seedAgent(env, now);
}
