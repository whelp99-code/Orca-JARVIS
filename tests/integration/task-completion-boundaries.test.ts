import { afterEach, expect, it, vi } from "vitest";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { executeTaskWorkflow } from "../../src/task-completion.js";
import { taskCompletionWorkflow } from "../../src/task-completion-workflow.js";
import { canonicalize } from "../../src/canonical.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { DEFAULT_AGENTOPS_LOOP, LoopGraph } from "../../src/loopgraph.js";
import type { AuthorityDb } from "../../src/db.js";

const databases: AuthorityDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const f = await taskExecutionFixture(); databases.push(f.db);
  f.approve(stageTaskExecution(f.db, f.request, f.now));
  return f;
}
type Table = "workflow_runs" | "control_command_requests";
function insert(db: AuthorityDb, table: Table, value: Record<string, any>, replace = false) {
  const keys = Object.keys(value);
  db.db.prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO ${table} (${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
    .run(...keys.map(key => value[key]));
}
function other(table: Table, row: Record<string, any>) {
  return table === "workflow_runs" ? { ...row, run_id: "other-run", input_json: "{}" }
    : { ...row, request_id: "other-request", nonce: "other-nonce", command_digest: candidateHash("other"), action: "workflow.start" };
}

it.each(["workflow_runs", "control_command_requests"] as const)("blocks initial completed task insertion in %s", async table => {
  const f = await fixture();
  const row = f.db.db.prepare(`SELECT * FROM ${table} WHERE ${table === "workflow_runs" ? "run_id='run'" : "request_id='execute'"}`)
    .get() as Record<string, any>;
  const value: Record<string, any> = { ...other(table, row), state: "completed" };
  if (table === "workflow_runs") value.input_json = row.input_json;
  else value.action = row.action;
  expect(() => insert(f.db, table, value)).toThrow("task completion receipt required");
});

const aliases = ["rowid", "_rowid_", "oid"] as const;
const tables = ["workflow_runs", "control_command_requests"] as const;
it.each(tables.flatMap(table => aliases.map(alias => ({ table, alias }))))(
  "blocks $table INSERT OR REPLACE through $alias with hidden task identity", async ({ table, alias }) => {
    const f = await fixture();
    const rows = () => f.db.db.prepare(`SELECT rowid AS fixture_rowid,* FROM ${table} ORDER BY rowid`).all();
    const before = rows();
    const row = f.db.db.prepare(`SELECT rowid AS fixture_rowid,* FROM ${table}
      WHERE ${table === "workflow_runs" ? "run_id='run'" : "request_id='execute'"}`).get() as Record<string, any>;
    const { fixture_rowid: rowid, ...content } = row;
    expect(() => insert(f.db, table, { ...other(table, content), [alias]: rowid }, true)).toThrow("immutable task");
    expect(rows()).toEqual(before);
  });

it.each(tables.flatMap(table => aliases.flatMap(alias => ["source", "target"].map(direction => ({ table, alias, direction })))))(
  "blocks $table UPDATE OR REPLACE through $alias when task is $direction", async ({ table, alias, direction }) => {
    const f = await fixture();
    const row = f.db.db.prepare(`SELECT rowid AS fixture_rowid,* FROM ${table}
      WHERE ${table === "workflow_runs" ? "run_id='run'" : "request_id='execute'"}`).get() as Record<string, any>;
    const { fixture_rowid: taskRowid, ...content } = row;
    insert(f.db, table, other(table, content));
    const otherRowid = Number((f.db.db.prepare("SELECT last_insert_rowid() AS n").get() as { n: number }).n);
    const rows = () => f.db.db.prepare(`SELECT rowid AS fixture_rowid,* FROM ${table} ORDER BY rowid`).all();
    const before = rows();
    expect(() => f.db.db.prepare(`UPDATE OR REPLACE ${table} SET ${alias}=? WHERE rowid=?`)
      .run(direction === "source" ? otherRowid : taskRowid, direction === "source" ? taskRowid : otherRowid)).toThrow();
    expect(rows()).toEqual(before);
  });

it("rejects candidate-only approval before invoking a provider", async () => {
  const f = await fixture(); const command = f.control.claim("execute", "test", f.now);
  const generate = vi.fn(); const verify = vi.fn(); const checkReady = vi.fn();
  await expect(executeTaskWorkflow({ authority: f.db, command, provider: { provider: "codex", generate }, clock: () => f.now,
    certification: { key_id: "verifier-test", process: { verify, checkReady } } }))
    .rejects.toThrow("TASK_COMPLETION_MODE_UNSUPPORTED");
  expect(generate).not.toHaveBeenCalled();
  expect(checkReady).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  expect(f.db.db.prepare("SELECT count(*) AS n FROM control_effect_attempts").get()).toEqual({ n: 0 });
});

it("rejects a custom definition reusing the built-in loop ID", async () => {
  const f = await fixture();
  // Simulate a pre-existing custom definition in this isolated fixture. Production definitions remain immutable.
  const triggers = f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='loop_definitions'")
    .all() as Array<{ name: string }>;
  for (const { name } of triggers) f.db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  const changed = structuredClone(DEFAULT_AGENTOPS_LOOP);
  changed.nodes.push({ ...changed.nodes[0]!, id: "extra-owner-check" });
  f.db.db.prepare("UPDATE loop_definitions SET spec_json=?,spec_digest=? WHERE loop_id=?")
    .run(canonicalize(changed), candidateHash(canonicalize(changed)), changed.loop_id);
  expect(() => taskCompletionWorkflow(f.db, "run", f.now)).toThrow("TASK_COMPLETION_WORKFLOW_UNSUPPORTED");
});

it.each(["steps", "node", "deadline"])("rejects exhausted workflow %s budget", async mode => {
  const f = await fixture();
  if (mode === "steps") f.db.db.exec("UPDATE workflow_runs SET attempts=10 WHERE run_id='run'");
  if (mode === "node") {
    const graph = new LoopGraph(f.db);
    graph.advance({ run_id: "run", outcome: "observed", output: {} }, f.now);
    // Existing evidence at the current node consumes the per-node allowance, independently of total attempts.
    for (let attempt = 1; attempt <= 2; attempt++) f.db.db.prepare(`INSERT INTO workflow_steps
      (step_id,run_id,node_id,attempt,outcome,output_json,output_digest,created_at) VALUES(?,'run',?,?,?,'{}',?,?)`)
      .run(`existing-${attempt}`, graph.get("run").current_node, attempt, "waiting", candidateHash("{}"), f.now.toISOString());
  }
  const now = mode === "deadline" ? new Date(f.workflow.budget.deadline) : f.now;
  expect(() => taskCompletionWorkflow(f.db, "run", now)).toThrow("TASK_COMPLETION_WORKFLOW_NOT_READY");
});
