import { afterEach, expect, it, vi } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { JarvisError } from "../../src/db.js";
import { AgentOpsMicroLoops } from "../../src/microloops.js";
import { executeDashboardRequest } from "../../src/dashboard/authority-service.js";
import { GjcRuntimeService } from "../../src/service.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { settleApprovedTaskError } from "../../src/approved-task-outcome.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(passed = true) { const f = await approvedTaskFixture(passed); cleanups.push(f.cleanup); return f; }

it("runs the approved task to a completed receipt and replays with no new claim or model call", async () => {
  const f = await fixture(); const result = await f.executor.execute("execute");
  expect(result).toMatchObject({ state: "completed", result: { state: "completed", run_id: "run" } });
  expect(result.result).toEqual(readTaskCompletion(f.db, "execute"));
  f.setNow(new Date(f.now.getTime() + 700_000));
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(await f.executor.execute("execute")).toEqual(result);
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(f.generate).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
});

it.each(["unconfigured", "unknown_key", "preflight", "cancel_during_preflight", "expire_during_preflight"])(
  "preserves approval before a model invocation when %s", async mode => {
    const f = await fixture();
    let executor = f.executor;
    if (mode === "unconfigured") {
      vi.stubEnv("JARVIS_TASK_CLAUDE_PATH", "");
      executor = new ApprovedCommandExecutor(f.db, undefined, undefined, {}, f.clock);
    }
    if (mode === "unknown_key") f.runtime.certification.key_id = "missing";
    if (mode === "preflight") f.runtime.checkReady.mockRejectedValue(new Error("private-provider-error"));
    if (mode === "cancel_during_preflight") f.runtime.checkReady.mockImplementation(async () => {
      f.control.cancel({ request_id: "execute", actor: "test-operator", reason: "stop", revoked_at: f.now.toISOString() }, f.now);
    });
    if (mode === "expire_during_preflight") f.runtime.checkReady.mockImplementation(async () => {
      f.setNow(new Date(f.workflow.budget.deadline));
    });
    await expect(executor.execute("execute")).rejects.toBeInstanceOf(JarvisError);
    expect(f.control.get("execute")?.state).toBe(mode === "cancel_during_preflight" ? "cancelled" : "approved");
    expect(f.generate).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM control_command_redemptions WHERE request_id='execute'").get()).toEqual({ n: 0 });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM control_effect_attempts WHERE request_id='execute'").get()).toEqual({ n: 0 });
  });

it("uses a fresh claim time after asynchronous readiness", async () => {
  const f = await fixture(); const later = new Date(f.now.getTime() + 10_000);
  f.runtime.checkReady.mockImplementation(async () => { f.setNow(later); });
  expect((await f.executor.execute("execute")).state).toBe("completed");
  expect(f.db.db.prepare("SELECT redeemed_at FROM control_command_redemptions WHERE request_id='execute'").get())
    .toEqual({ redeemed_at: later.toISOString() });
});

it("records failed checks without publishing or returning a successful workflow", async () => {
  const f = await fixture(false); const result = await f.executor.execute("execute");
  expect(result).toMatchObject({ state: "failed", failure_code: "TASK_CHECKS_FAILED" });
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
  expect(f.db.db.prepare("SELECT state FROM workflow_runs WHERE run_id='run'").get()).toEqual({ state: "running" });
  expect(f.db.db.prepare("SELECT count(*) AS n FROM task_git_publications").get()).toEqual({ n: 0 });
  await expect(f.executor.execute("execute")).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");
  expect(f.generate).toHaveBeenCalledOnce();
});

it.each(["provider_failure", "cancel_after_provider", "expire_after_provider", "verify_failure"])(
  "retains uncertainty and redacts errors after %s", async mode => {
    const f = await fixture(); const generate = f.generate.getMockImplementation()!;
    if (mode === "provider_failure") f.generate.mockRejectedValue(new Error("private-provider-error"));
    if (mode === "verify_failure") f.verify.mockRejectedValue(new Error("private-verifier-error"));
    if (mode === "cancel_after_provider" || mode === "expire_after_provider") f.generate.mockImplementation(async input => {
      const result = await generate(input);
      if (mode === "cancel_after_provider") f.control.cancel({ request_id: "execute", actor: "test-operator", reason: "stop",
        revoked_at: f.now.toISOString() }, f.now);
      else f.setNow(new Date(f.now.getTime() + f.plan.limits.timeout_ms));
      return result;
    });
    const result = await f.executor.execute("execute");
    expect(result.state).toBe("uncertain"); expect(JSON.stringify(result)).not.toContain("private-");
    expect(f.control.get("execute")?.state).toBe("uncertain");
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts WHERE request_id='execute'").get()).toEqual({ state: "uncertain" });
    await expect(f.executor.execute("execute")).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");
    expect(f.generate).toHaveBeenCalledOnce();
  });

it("keeps approved model work out of the serial microloop without starving a later command", async () => {
  const f = await fixture();
  f.approve(f.control.stage({ schema_version: 1, request_id: "zz-later", nonce: "zz-later", action: "state.project", action_level: 1,
    target: { environment: "local" }, args: {}, reversible: true, requested_by: "test-operator", requested_at: f.now.toISOString(),
    expires_at: f.workflow.budget.deadline }, f.now));
  expect(f.control.nextApproved(f.now)).toBe("execute");
  const run = vi.spyOn(f.executor, "execute").mockResolvedValue({ request_id: "zz-later", action: "state.project", state: "completed", result: {} });
  const client = new GjcCoordinatorClient(async () => { throw new Error("unexpected coordinator call"); });
  const handler = new AgentOpsMicroLoops(f.db, f.executor, new GjcRuntimeService(f.db, client), async () => null)
    .handlers().find(handler => handler.name === "approved-command")!;
  await handler.run(f.now); expect(run).toHaveBeenCalledWith("zz-later", "approved-command-loop", f.now);
  expect(f.control.get("execute")?.state).toBe("approved"); expect(f.generate).not.toHaveBeenCalled();
});

it("exposes completion through the dashboard authority execution path", async () => {
  const f = await fixture();
  const result = await executeDashboardRequest({ db: f.db, requestId: "execute", now: f.now,
    clock: f.clock, body: { schema_version: 1 }, executorFactory: () => f.executor });
  expect(result.execution).toEqual({ request_id: "execute", action: "task.execute", state: "completed" });
  expect(readTaskCompletion(f.db, "execute")).not.toBeNull();
});

it("keeps a published Git result uncertain when completion recording fails", async () => {
  const f = await fixture();
  f.db.db.exec(`CREATE TRIGGER fixture_completion_failure BEFORE INSERT ON control_events
    WHEN NEW.event_type='workflow.task_completed' BEGIN SELECT RAISE(ABORT,'private-sql-error'); END`);
  const result = await f.executor.execute("execute");
  expect(result).toMatchObject({ state: "uncertain", failure_code: "TASK_EXECUTION_UNCERTAIN" });
  const row = f.db.db.prepare("SELECT state,commit_oid FROM task_git_publications").get() as { state: string; commit_oid: string };
  expect(row.state).toBe("published"); expect(f.git(["rev-parse", f.plan.publication.ref])).toBe(row.commit_oid);
  expect(readTaskCompletion(f.db, "execute")).toBeNull(); expect(f.generate).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("private-");
});

it("does not retry or claim failure settlement when its event transaction rolls back", async () => {
  const f = await fixture(false); let tries = 0;
  f.db.db.function("fixture_count_failure", () => { tries++; return 1; });
  f.db.db.exec(`CREATE TRIGGER fixture_failure_settlement BEFORE INSERT ON control_events
    WHEN NEW.event_type='control.command.failed'
    BEGIN SELECT fixture_count_failure(); SELECT RAISE(ABORT,'private-sql-error'); END`);
  await expect(f.executor.execute("execute")).rejects.toThrow("TASK_EXECUTION_SETTLEMENT_FAILED");
  expect(tries).toBe(1); expect(f.control.get("execute")?.state).toBe("claimed");
  expect(f.db.db.prepare("SELECT state FROM control_effect_attempts WHERE request_id='execute'").get()).toEqual({ state: "invoking" });
  expect(f.db.db.prepare("SELECT count(*) AS n FROM control_command_effects WHERE request_id='execute'").get()).toEqual({ n: 0 });
  expect(f.generate).toHaveBeenCalledOnce();
});

it("reads failure-settlement time only after acquiring the writer transaction", async () => {
  const f = await fixture(); const command = f.control.claim("execute", "fixture", f.now);
  const result = settleApprovedTaskError(f.db, command, "TASK_CHECKS_FAILED", true, () => {
    expect(f.db.db.inTransaction).toBe(true);
    return new Date(command.lease_expires_at);
  });
  expect(result).toMatchObject({ state: "uncertain", failure_code: "CONTROL_CLAIM_EXPIRED" });
  expect(f.control.get("execute")?.state).toBe("uncertain");
  expect(f.db.db.prepare("SELECT count(*) AS n FROM control_command_effects WHERE request_id='execute'").get()).toEqual({ n: 0 });
});
