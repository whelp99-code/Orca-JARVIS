import { afterEach, expect, it } from "vitest";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { spawnSync } from "node:child_process";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const f = await taskPublicationFixture(); cleanups.push(f.cleanup);
  const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
  return { ...f, input: { ...input, publication_id: publication.publication_id }, publication };
}

it("rejects a historical completion when its stored certification bytes are lost", async () => {
  const f = await fixture(); await settleTaskExecution(f.input);
  const triggers = f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='task_candidate_certifications'")
    .all() as Array<{ name: string }>;
  for (const { name } of triggers) f.db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  f.db.db.prepare("UPDATE task_candidate_certifications SET proof_json='{}'").run();
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(() => readTaskCompletion(f.db, "execute")).toThrow("TASK_COMPLETION_INVALID");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AuthorityDb } from './dist/src/db.js';
    import { readTaskCompletion } from './dist/src/task-completion-record.js';
    const db = new AuthorityDb(process.argv[1]);
    try { readTaskCompletion(db, 'execute'); process.exitCode = 1; }
    catch (error) { process.stdout.write(error.code ?? 'unexpected'); }
    finally { db.close(); }
  `, f.db.filename], { encoding: "utf8", timeout: 10000 });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("TASK_COMPLETION_INVALID");
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("atomically completes the verified request, operation and built-in workflow with a read-only replay", async () => {
  const f = await fixture(); const result = await settleTaskExecution(f.input);
  expect(result).toMatchObject({ state: "completed", run_id: "run", request_id: "execute", commit: f.publication.commit,
    from_node: "observe", prior_attempts: 0, node_attempt: 1 });
  expect(f.control.get("execute")).toMatchObject({ state: "completed" });
  expect(f.db.db.prepare("SELECT lease_expires_at FROM control_command_requests WHERE request_id='execute'").get())
    .toEqual({ lease_expires_at: null });
  expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "confirmed" });
  expect(new LoopGraph(f.db).get("run")).toMatchObject({ state: "completed", current_node: "complete", attempts: 1 });
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  expect(readTaskCompletion(f.db, "execute")).toEqual(result);
  expect(await settleTaskExecution({ ...f.input, clock: () => new Date(f.input.command.lease_expires_at) })).toEqual(result);
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(() => f.db.db.exec("UPDATE task_completions SET payload_json='{}'")).toThrow();
  expect(() => f.db.db.exec("DELETE FROM task_completions")).toThrow();
  expect(() => f.db.db.exec("INSERT OR REPLACE INTO task_completions SELECT * FROM task_completions")).toThrow();
  await expect(settleTaskExecution({ ...f.input, publication_id: "other" })).rejects.toThrow("TASK_COMPLETION_INVALID");
  await expect(settleTaskExecution({ ...f.input, command: { ...f.input.command, fence: f.input.command.fence + 1 } }))
    .rejects.toThrow("TASK_COMPLETION_INVALID");
});

it.each(["api_command", "sql_command", "sql_attempt", "sql_workflow", "graph_no_action"])(
  "blocks %s completion without a bound completion receipt", async scenario => {
    const f = await fixture();
    const action = () => {
      if (scenario === "api_command") f.control.settle("execute", f.input.command.fence,
        { state: "completed", effect_type: "claimed.success", payload: { passed: true } }, f.now);
      if (scenario === "sql_command") f.db.db.exec("UPDATE control_command_requests SET state='completed' WHERE request_id='execute'");
      if (scenario === "sql_attempt") f.db.db.exec("UPDATE control_effect_attempts SET state='confirmed'");
      if (scenario === "sql_workflow") f.db.db.exec("UPDATE workflow_runs SET state='completed' WHERE run_id='run'");
      if (scenario === "graph_no_action") {
        const graph = new LoopGraph(f.db); graph.advance({ run_id: "run", outcome: "observed", output: {} }, f.now);
        graph.advance({ run_id: "run", outcome: "no_action", output: { passed: true }, evidence_digest: candidateHash("claim") }, f.now);
      }
    };
    expect(action).toThrow("task completion receipt required");
    expect(readTaskCompletion(f.db, "execute")).toBeNull();
    expect(f.control.get("execute")?.state).toBe("claimed");
    expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
    expect(new LoopGraph(f.db).get("run").state).not.toBe("completed");
  });

it.each(["missing", "moved", "symbolic"])("rejects an actual %s publication ref before completion", async mode => {
  const f = await fixture();
  if (mode === "missing") f.git(["update-ref", "-d", f.publication.ref]);
  if (mode === "moved") f.git(["update-ref", f.publication.ref, f.plan.repository.baseline_commit]);
  if (mode === "symbolic") f.git(["symbolic-ref", f.publication.ref, "refs/heads/missing"]);
  await expect(settleTaskExecution(f.input)).rejects.toThrow("TASK_COMPLETION_REF_CONFLICT");
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
});

it.each(["cancelled", "expired", "verifier_revoked"])("rejects %s authority before settlement", async mode => {
  const f = await fixture(); let now = f.now;
  if (mode === "cancelled") f.control.cancel({ request_id: "execute", reason: "stop", revoked_by: "test-operator",
    revoked_at: now.toISOString() }, now);
  if (mode === "expired") now = new Date(f.input.command.lease_expires_at);
  if (mode === "verifier_revoked") f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
    .run("verifier-test", "revoked", now.toISOString());
  await expect(settleTaskExecution({ ...f.input, clock: () => now })).rejects.toThrow();
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
  expect(new LoopGraph(f.db).get("run").state).toBe("running");
});

it.each(["event_failure", "expired_at_commit", "revoked_at_commit"])("rolls every completion write back on %s", async mode => {
  const f = await fixture(); let now = f.now;
  if (mode === "event_failure") f.db.db.exec(`CREATE TRIGGER fixture_completion_fail BEFORE INSERT ON control_events
    WHEN NEW.event_type='workflow.task_completed' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END`);
  if (mode === "expired_at_commit") {
    f.db.db.function("fixture_completion_expire", () => { now = new Date(f.input.command.lease_expires_at); return 1; });
    f.db.db.exec(`CREATE TRIGGER fixture_completion_expire AFTER INSERT ON control_events
      WHEN NEW.event_type='workflow.task_completed' BEGIN SELECT fixture_completion_expire(); END`);
  }
  if (mode === "revoked_at_commit") f.db.db.exec(`CREATE TRIGGER fixture_completion_revoke AFTER INSERT ON control_events
    WHEN NEW.event_type='workflow.task_completed' BEGIN INSERT INTO authority_revocations(reference,reason,created_at)
      VALUES('verifier-test','fixture',NEW.created_at); END`);
  await expect(settleTaskExecution({ ...f.input, clock: () => now })).rejects.toThrow();
  expect(readTaskCompletion(f.db, "execute")).toBeNull();
  expect(f.control.get("execute")?.state).toBe("claimed");
  expect(f.db.db.prepare("SELECT state FROM control_effect_attempts").get()).toEqual({ state: "invoking" });
  expect(new LoopGraph(f.db).get("run")).toMatchObject({ state: "running", current_node: "observe", attempts: 0 });
  expect(f.db.db.prepare("SELECT count(*) AS n FROM workflow_steps").get()).toEqual({ n: 0 });
});
