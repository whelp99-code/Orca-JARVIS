import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";

const migration = "079_task_execution_read_indexes.sql";
function queries() {
  const execution = readFileSync("src/dashboard/task-execution-read.ts", "utf8");
  const routing = readFileSync("src/dashboard/task-routing-read.ts", "utf8");
  return [...execution.matchAll(/prepare\(`([\s\S]*?)`\)/g), ...routing.matchAll(/prepare\(`([\s\S]*?)`\)/g)]
    .map(match => match[1]!);
}

it("upgrades populated history without changing rows and indexes all three live lookup queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-task-read-upgrade-"));
  const prefix = join(root, "migrations"); mkdirSync(prefix);
  for (const file of readdirSync("migrations").filter(file => file.endsWith(".sql") && file < migration)) {
    copyFileSync(join("migrations", file), join(prefix, file));
  }
  let db = new AuthorityDb(join(root, "authority.sqlite"), prefix);
  try {
    await db.migrate();
    const at = "2026-09-09T00:00:00.000Z";
    db.db.prepare("INSERT INTO loop_definitions VALUES('loop',1,'fixture','{}','fixture-loop','active',?)").run(at);
    const command = db.db.prepare(`INSERT INTO control_command_requests(request_id,action,action_level,target_json,args_json,
      command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES(?,?,2,?,?,?,1,'fixture',?,? ,?,'pending',?)`);
    const run = db.db.prepare(`INSERT INTO workflow_runs(run_id,loop_id,state,current_node,correlation_id,input_json,budget_json,
      created_at,updated_at) VALUES(?,'loop','running','observe',?,?,'{}',?,?)`);
    db.db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const id = `run-${i}`, target = JSON.stringify({ task_id: i < 30 ? "shared" : `task-${i}` });
        command.run(id, "workflow.start", target, JSON.stringify({ run_id: id }), id, at, at, id, at);
        command.run(`exec-${id}`, "task.execute", target, "{}", `exec-${id}`, at, at, `exec-${id}`, at);
        db.db.prepare("UPDATE control_command_requests SET state='completed' WHERE request_id=?").run(id);
        db.db.prepare("INSERT INTO control_command_effects VALUES(?,?,'workflow.started','{}',?,?)").run(id, id, id, at);
        run.run(id, `task-${i}`, target, at, at);
      }
      command.run("broken", "workflow.start", "{", "{", "broken", at, at, "broken", at);
      command.run("broken-exec", "task.execute", "{", "{", "broken-exec", at, at, "broken-exec", at);
      run.run("broken", "broken", "{", at, at);
    })();
    const tables = ["control_command_requests", "control_command_effects", "workflow_runs"];
    const snapshot = () => tables.map(table => db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    db.close(); db = new AuthorityDb(join(root, "authority.sqlite"), resolve("migrations"));
    await db.migrate(); await db.migrate();
    const expectedSnapshot = before.map((rows, table) => table === 0 ? rows.map(row => {
      if (row === null || typeof row !== "object") throw new Error("expected a historical control row");
      return { ...row, schema_version: 1 };
    }) : rows);
    expect(snapshot()).toEqual(expectedSnapshot);
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    const expected = ["workflow_runs_task_page", "control_task_execution_page", "control_workflow_start_run"];
    const sql = queries(); expect(sql).toHaveLength(3);
    sql.forEach((query, index) => {
      const arg = index === 2 ? "run-999" : "task-999";
      const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(arg) as { detail: string }[];
      expect(plan.some(row => row.detail.includes(expected[index]!))).toBe(true);
      expect(plan.some(row => /SCAN |TEMP B-TREE/.test(row.detail))).toBe(false);
      expect(db.db.prepare(query).all(arg)).toHaveLength(1);
    });
    for (const query of sql.slice(0, 2)) {
      const result = db.db.prepare(query).all("shared") as Record<string, string>[];
      const ids = result.map(row => Object.values(row)[0]!);
      const prefix = query.includes("workflow_runs") ? "run-" : "exec-run-";
      const expectedIds = Array.from({ length: 30 }, (_, i) => `${prefix}${i}`).sort().reverse().slice(0, 21);
      expect(ids).toEqual(expectedIds);
    }
    expect(db.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id=?").get(migration)).toEqual({ n: 1 });
    expect(() => db.db.prepare("UPDATE control_command_requests SET args_json='{}' WHERE request_id='broken'").run())
      .toThrow("immutable control command identity");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
