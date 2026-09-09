import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";

it("reads replay visibility and completion from one snapshot during a concurrent quarantine", async () => {
  const f = await approvedTaskFixture();
  let other: AuthorityDb | undefined;
  try {
    const completed = await f.executor.execute("execute");
    other = new AuthorityDb(f.db.filename);
    const original = MemoryProjectionAuthority.prototype.isProjectionIdSuppressed;
    let interleaved = false;
    const spy = vi.spyOn(MemoryProjectionAuthority.prototype, "isProjectionIdSuppressed").mockImplementation(function (this: MemoryProjectionAuthority, id) {
      const result = original.call(this, id);
      if (id === f.plan.task_id && !interleaved) {
        interleaved = true;
        expect(f.db.db.inTransaction).toBe(true);
        new MemoryProjectionAuthority(other!).quarantineUnresolved({ kind: "task_timeline",
          id, component_id: id }, f.clock());
      }
      return result;
    });
    try { expect(await f.executor.execute("execute")).toEqual(completed); }
    finally { spy.mockRestore(); }
    expect(interleaved).toBe(true);
    await expect(f.executor.execute("execute")).rejects.toThrow("TASK_EXECUTION_SOURCE_SUPPRESSED");
    expect(f.generate).toHaveBeenCalledOnce();
  } finally { other?.close(); await f.cleanup(); }
});

it("does not disclose historical completion on a new execute call after task quarantine", async () => {
  const f = await approvedTaskFixture();
  try {
    expect((await f.executor.execute("execute")).state).toBe("completed");
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "task_timeline",
      id: f.plan.task_id, component_id: f.plan.task_id }, f.clock());
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    await expect(f.executor.execute("execute")).rejects.toThrow("TASK_EXECUTION_SOURCE_SUPPRESSED");
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM task_completions").get()).toEqual({ n: 1 });
  } finally { await f.cleanup(); }
});

it("rejects an already approved task before invoking its provider after task quarantine", async () => {
  const f = await approvedTaskFixture();
  try {
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "task_timeline",
      id: f.plan.task_id, component_id: f.plan.task_id }, f.clock());
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    await expect(f.executor.execute("execute")).rejects.toThrow("TASK_EXECUTION_SOURCE_SUPPRESSED");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { await f.cleanup(); }
});

it("does not publish or complete when the task becomes quarantined during provider execution", async () => {
  const f = await approvedTaskFixture();
  try {
    const generate = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async input => {
      const result = await generate(input);
      new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "task_timeline",
        id: f.plan.task_id, component_id: f.plan.task_id }, f.clock());
      return result;
    });
    expect((await f.executor.execute("execute")).state).toBe("uncertain");
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.verify).not.toHaveBeenCalled();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM task_completions").get()).toEqual({ n: 0 });
    expect(f.git(["for-each-ref", "--format=%(refname)"])).not.toContain(f.plan.publication.ref);
    await expect(f.executor.execute("execute")).rejects.toThrow();
    expect(f.generate).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});
