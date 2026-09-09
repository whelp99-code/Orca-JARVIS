import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { execute } from "../../src/cli.js";
import { readTaskRoutingShadow } from "../../src/task-routing-shadow.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";

const policy = (executor = "claude", keyword = "Fix") => ({ schema_version: 1, policy_id: "shadow-test", revision: 1,
  rules: [{ id: "code", keywords: [keyword], executor_ids: [executor], record_stores: ["second-brain"] }] });
async function fixture() {
  const f = await taskExecutionFixture();
  stageTaskExecution(f.db, f.request, f.now);
  const from = new Date(f.now.getTime() - 1000).toISOString(), to = new Date(f.now.getTime() + 1000).toISOString();
  const at = new Date(f.now.getTime() + 2000);
  return { ...f, from, to, at, read: (a: unknown, b: unknown) => readTaskRoutingShadow(f.db, from, to, a, b, at),
    cleanup: async () => { f.db.close(); await rm(dirname(f.db.filename), { recursive: true, force: true }); } };
}

it("compares original task inputs, binds policies and evidence, and performs no writes or execution", async () => {
  const f = await fixture();
  try {
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    const result = f.read(policy(), policy("codex"));
    expect(result).toMatchObject({ requests: 1, compared_requests: 1, unavailable_inputs: 0, coverage: 1,
      classified_targets: { changed: 1, unchanged: 0 }, transitions: { classified_to_classified: 1 },
      outcome_comparison: "unavailable_candidate_not_executed", executable: false, policy_promoted: false });
    expect(f.read(policy(), policy("codex"))).toEqual(result);
    expect(f.read(policy(), policy())).toMatchObject({ classified_targets: { changed: 0, unchanged: 1 } });
    expect(f.read(policy(), policy()).cohort_digest).not.toBe(result.cohort_digest);
    expect(JSON.stringify(result)).not.toContain(f.workflow.input.objective);
    expect(f.control.get("execute")?.state).toBe("pending");
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { await f.cleanup(); }
});

it("separates classification transitions from target changes and counts ambiguous rules as review", async () => {
  const f = await fixture();
  try {
    const none = policy("codex", "email");
    const conflict = { ...policy(), rules: [...policy().rules, { ...policy("codex").rules[0]!, id: "other" }] };
    expect(f.read(policy(), none).transitions.classified_to_review).toBe(1);
    expect(f.read(none, policy()).transitions.review_to_classified).toBe(1);
    expect(f.read(none, conflict).transitions.review_to_review).toBe(1);
    expect(f.read(policy(), conflict).classified_targets).toEqual({ changed: 0, unchanged: 0 });
    const left = { ...policy(), rules: [{ ...policy().rules[0]!, executor_ids: ["claude", "codex"] }] };
    const right = { ...left, rules: [{ ...left.rules[0]!, executor_ids: ["codex", "claude"] }] };
    expect(f.read(left, right).classified_targets.unchanged).toBe(1);
  } finally { await f.cleanup(); }
});

it("excludes currently hidden and broken source bindings without silently claiming full coverage", async () => {
  const f = await fixture();
  try {
    const original = ControlPlane.prototype.get;
    const hidden = vi.spyOn(ControlPlane.prototype, "get").mockImplementation(function(this: ControlPlane, id: string) {
      return id === "start" ? undefined : original.call(this, id);
    });
    try { expect(f.read(policy(), policy())).toMatchObject({ compared_requests: 0, unavailable_inputs: 1,
      coverage: 0, status: "incomplete_inputs" }); } finally { hidden.mockRestore(); }
    const broken = vi.spyOn(ControlPlane.prototype, "get").mockImplementation(function(this: ControlPlane, id: string) {
      const row = original.call(this, id);
      return id === "start" && row ? { ...row, args: { ...row.args, input: {} } } : row;
    });
    try { expect(f.read(policy(), policy()).unavailable_inputs).toBe(1); } finally { broken.mockRestore(); }
  } finally { await f.cleanup(); }
});

it("uses a half-open cohort, validates policies for empty cohorts and rejects truncation", async () => {
  const f = await fixture();
  try {
    const empty = readTaskRoutingShadow(f.db, f.from, f.now.toISOString(), policy(), policy(), f.at);
    expect(empty).toMatchObject({ requests: 0, coverage: null, status: "no_requests" });
    expect(() => readTaskRoutingShadow(f.db, f.from, f.now.toISOString(), {}, policy(), f.at)).toThrow("WORK_ROUTING_INPUT_INVALID");
    const insert = f.db.db.prepare(`INSERT INTO control_command_requests
      (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES(?,'task.execute',3,'{}','{}',?,0,'fixture',?,?,?,'pending',?)`);
    f.db.db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(`raw-${i}`, `digest-${i}`,
      f.now.toISOString(), f.to, `nonce-${i}`, f.now.toISOString()); })();
    expect(() => f.read(policy(), policy())).toThrow("TASK_PERFORMANCE_COHORT_LIMIT");
  } finally { await f.cleanup(); }
});

it("runs the compiled report in a separate process and rejects invalid input before database creation", async () => {
  const f = await fixture();
  try {
    const left = join(dirname(f.db.filename), "baseline.json"), right = join(dirname(f.db.filename), "candidate.json");
    writeFileSync(left, JSON.stringify(policy())); writeFileSync(right, JSON.stringify(policy("codex")));
    // Observe after request creation using the child's real clock, without future window bounds.
    const to = new Date().toISOString();
    const result = JSON.parse(execFileSync(process.execPath, [resolve("dist/src/cli.js"), "report", "routing-shadow",
      f.from, to, left, right, "--db", f.db.filename], { encoding: "utf8" }));
    expect(result.report.classified_targets.changed).toBe(1);
    expect(result.report.policy_promoted).toBe(false);
    const missing = join(dirname(f.db.filename), "missing.sqlite");
    await expect(execute(["report", "routing-shadow", f.from, to, left, right, "--db", missing]))
      .rejects.toThrow("TASK_PERFORMANCE_DATABASE_UNAVAILABLE");
    writeFileSync(right, '{"schema_version":1,"schema_version":1}');
    await expect(execute(["report", "routing-shadow", f.from, to, left, right, "--db", missing]))
      .rejects.toThrow("WORK_ROUTING_INPUT_INVALID");
    expect(existsSync(missing)).toBe(false);
  } finally { await f.cleanup(); }
});
