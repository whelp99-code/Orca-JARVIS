import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { controlActionDescriptor } from "../../src/control-actions.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";

function close(fixture: Awaited<ReturnType<typeof taskExecutionFixture>>) {
  fixture.db.close(); rmSync(dirname(fixture.db.filename), { recursive: true, force: true });
}
describe("execution plan staging after approved workflow start", () => {
  it("creates a separate pending approval, preserves the full plan, and replays without writes", async () => {
    const fixture = await taskExecutionFixture();
    try {
      const result = stageTaskExecution(fixture.db, fixture.request, fixture.now);
      expect(result).toMatchObject({ action: "task.execute", action_level: 3, state: "pending", args: { plan: fixture.plan } });
      expect(Date.parse(result.expires_at)).toBe(Date.parse(fixture.workflow.budget.deadline));
      const changes = fixture.db.db.prepare("SELECT total_changes() AS n").get();
      expect(stageTaskExecution(fixture.db, fixture.request, new Date(fixture.now.getTime() + 1))).toEqual(result);
      expect(fixture.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
      expect(fixture.db.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts").get()).toEqual({ n: 0 });
      expect(controlActionDescriptor("task.execute")).toMatchObject({ executable: true });
      fixture.approve(result);
      await expect(new ApprovedCommandExecutor(fixture.db, undefined, undefined, {}, () => fixture.now)
        .execute(result.request_id)).rejects.toThrow("TASK_COMPLETION_MODE_UNSUPPORTED");
      expect(fixture.control.get(result.request_id)?.state).toBe("approved");
      expect(fixture.db.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts").get()).toEqual({ n: 0 });
    } finally { close(fixture); }
  });

  it.each(["unapproved_start", "spec", "cancelled", "expired", "task_id", "replay"])("rejects %s before new writes", async change => {
    const fixture = await taskExecutionFixture(change !== "unapproved_start");
    try {
      let now = fixture.now;
      if (change === "spec") fixture.request.plan = { ...fixture.plan, task_spec_digest: `sha256:${"d".repeat(64)}` };
      if (change === "cancelled") fixture.db.db.prepare("UPDATE workflow_runs SET state='cancelled' WHERE run_id='run'").run();
      if (change === "expired") now = new Date(fixture.workflow.budget.deadline);
      if (change === "task_id") fixture.request.plan = { ...fixture.plan, task_id: "another-task" };
      if (change === "replay") {
        stageTaskExecution(fixture.db, fixture.request, now);
        fixture.request.plan = { ...fixture.plan, provider: "claude" };
      }
      const changes = fixture.db.db.prepare("SELECT total_changes() AS n").get();
      expect(() => stageTaskExecution(fixture.db, fixture.request, now)).toThrow();
      expect(fixture.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    } finally { close(fixture); }
  });

  it("stages through the built CLI process without executing an agent", async () => {
    const fixture = await taskExecutionFixture();
    try {
      const file = join(dirname(fixture.db.filename), "plan.json");
      writeFileSync(file, JSON.stringify(fixture.request));
      const { stdout } = await promisify(execFile)(process.execPath,
        ["dist/src/cli.js", "control", "plan-task", file, "--db", fixture.db.filename], { timeout: 15_000 });
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: "control.plan-task",
        request: { action: "task.execute", state: "pending", args: { plan: fixture.plan } } });
      expect(fixture.db.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts").get()).toEqual({ n: 0 });
    } finally { close(fixture); }
  });
});
