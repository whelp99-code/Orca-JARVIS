import { expect, it } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { controlRequestPage, pendingControlSummary } from "../../src/dashboard/control-request-read.js";

it.each(["payload", "task"])("does not consume approval or expose requests after ancestor %s quarantine", async kind => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan }, new Date(f.now.getTime() - 1));
    const child = stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "child", nonce: "child",
      work_lineage: { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }, f.now);
    f.approve(child);
    const id = kind === "payload" ? prior.request_id : f.plan.task_id;
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: kind === "payload" ? "control_payload" : "task_timeline",
      id, component_id: id }, f.now);
    expect(f.control.get(child.request_id)).toBeUndefined();
    const before = f.db.db.serialize();
    const { command_digest: _digest, state: _state, ...replay } = child;
    void _digest; void _state;
    expect(() => f.control.stage(replay, f.now)).toThrow("CONTROL_APPROVAL_REQUIRED");
    expect(controlRequestPage(f.db, f.now, { limit: 1 }).items).toEqual([]);
    expect(controlRequestPage(f.db, f.now, { limit: 1 }).page?.total).toBe(0);
    expect(controlRequestPage(f.db, f.now).items).toEqual([]);
    expect(pendingControlSummary(f.db, f.now)).toEqual({ total: 0, items: [] });
    expect(f.control.nextApproved(f.now)).toBeNull();
    expect(() => f.control.claim(child.request_id, "direct", f.now)).toThrow("CONTROL_APPROVAL_REQUIRED");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    await expect(f.executor.execute(child.request_id, "executor", f.now)).rejects.toThrow(
      kind === "task" ? "TASK_EXECUTION_SOURCE_SUPPRESSED" : "CONTROL_APPROVAL_REQUIRED");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
