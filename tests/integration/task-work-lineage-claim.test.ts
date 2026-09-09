import { expect, it } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { controlRequestPage, pendingControlSummary } from "../../src/dashboard/control-request-read.js";

it("does not consume approval or change state when an ancestor is quarantined", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan }, new Date(f.now.getTime() - 1));
    const child = stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "child", nonce: "child",
      work_lineage: { schema_version: 1, kind: "rework", prior_request_id: prior.request_id,
        prior_command_digest: prior.command_digest } }, f.now);
    f.approve(child);
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: prior.request_id,
      component_id: prior.request_id }, f.now);
    expect(f.control.get(child.request_id)).toBeUndefined();
    const before = f.db.db.serialize();
    expect(controlRequestPage(f.db, f.now, { limit: 1 }).items).toEqual([]);
    expect(controlRequestPage(f.db, f.now, { limit: 1 }).page?.total).toBe(0);
    expect(controlRequestPage(f.db, f.now).items).toEqual([]);
    expect(pendingControlSummary(f.db, f.now)).toEqual({ total: 0, items: [] });
    expect(f.control.nextApproved(f.now)).toBeNull();
    expect(() => f.control.claim(child.request_id, "direct", f.now)).toThrow("CONTROL_APPROVAL_REQUIRED");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    await expect(f.executor.execute(child.request_id, "executor", f.now)).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");
    expect(f.db.db.serialize().equals(before)).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
