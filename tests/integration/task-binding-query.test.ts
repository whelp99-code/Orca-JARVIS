import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { assertTaskExecutionBinding } from "../../src/task-execution-staging.js";

it("uses the workflow-start run index without bypassing original approval validation", async () => {
  const f = await approvedTaskFixture(true, { stage: false });
  try {
    const source = readFileSync("src/task-execution-staging.ts", "utf8");
    const sql = [...source.matchAll(/prepare\(`([\s\S]*?)`\)/g)]
      .map(match => match[1]!).find(query => query.startsWith("SELECT r.args_json"));
    expect(sql).toBeDefined();
    const plan = f.db.db.prepare(`EXPLAIN QUERY PLAN ${sql!}`).all(f.plan.run_id) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("control_workflow_start_run"))).toBe(true);
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    expect(() => assertTaskExecutionBinding(f.db, f.plan, f.clock())).not.toThrow();
    expect(() => assertTaskExecutionBinding(f.db, { ...f.plan, task_spec_digest: `sha256:${"f".repeat(64)}` }, f.clock()))
      .toThrow("TASK_EXECUTION_BINDING_INVALID");
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { await f.cleanup(); }
});
