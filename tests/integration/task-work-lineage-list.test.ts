import { expect, it, vi } from "vitest";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { listControlCommands, readControlCommand } from "../../src/control-command-read.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";

it("reuses loaded ancestors within a list snapshot and observes quarantine on the next call", async () => {
  const f = await taskPublicationFixture();
  try {
    let prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      work_lineage: { schema_version: 1, kind: "original" } }, f.now);
    const root = prior;
    for (let index = 1; index <= 63; index++) {
      prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: `chain-${index}`, nonce: `chain-${index}`,
        work_lineage: { schema_version: 1, kind: "retry", prior_request_id: prior.request_id,
          prior_command_digest: prior.command_digest } }, new Date(f.now.getTime() + index));
    }
    const before = f.db.db.serialize();
    const prepare = vi.spyOn(f.db.db, "prepare");
    const payload = vi.spyOn(MemoryProjectionAuthority.prototype, "isSuppressed");
    const task = vi.spyOn(MemoryProjectionAuthority.prototype, "isProjectionIdSuppressed");
    let listed;
    try {
      listed = listControlCommands(f.db);
      expect(listed).toHaveLength(65);
      expect(prepare.mock.calls.filter(([sql]) => sql === "SELECT * FROM control_command_requests WHERE request_id=?")).toHaveLength(0);
      expect(payload).toHaveBeenCalledTimes(65);
      expect(task).toHaveBeenCalledTimes(1);
    } finally { prepare.mockRestore(); payload.mockRestore(); task.mockRestore(); }
    expect(listed).toEqual(listed.map(row => readControlCommand(f.db, row.request_id)));
    expect(f.db.db.serialize().equals(before)).toBe(true);
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "control_payload", id: root.request_id,
      component_id: root.request_id }, new Date(f.now.getTime() + 64));
    const hidden = f.db.db.serialize();
    expect(listControlCommands(f.db).map(row => row.request_id)).toEqual(["start"]);
    expect(f.db.db.serialize().equals(hidden)).toBe(true);
  } finally { await f.cleanup(); }
});
