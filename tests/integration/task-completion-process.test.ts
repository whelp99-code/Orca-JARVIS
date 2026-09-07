import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { publishTaskGitCandidate } from "../../src/task-git-publication.js";
import { readTaskCompletion } from "../../src/task-completion-record.js";
import { settleTaskExecution } from "../../src/task-completion.js";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";

const message = (child: ChildProcess) => once(child, "message", { signal: AbortSignal.timeout(10_000) });
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) }); child.kill("SIGKILL"); await exited;
}
function start(filename: string) {
  return fork("tests/fixtures/task-completion-worker.mjs", [filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}
function states(db: AuthorityDb) {
  return { request: db.db.prepare("SELECT state FROM control_command_requests WHERE request_id='execute'").get(),
    attempt: db.db.prepare("SELECT state FROM control_effect_attempts").get(),
    workflow: db.db.prepare("SELECT state,current_node,attempts FROM workflow_runs WHERE run_id='run'").get(),
    receipts: db.db.prepare("SELECT count(*) AS n FROM task_completions").get(),
    events: db.db.prepare("SELECT count(*) AS n FROM control_events WHERE event_type='workflow.task_completed'").get() };
}

it.each(["before_commit", "after_commit"])("recovers completion after actual SIGKILL %s", async mode => {
  const f = await taskPublicationFixture(); let child: ChildProcess | undefined; let reopened: AuthorityDb | undefined;
  try {
    const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
    child = start(f.db.filename); expect((await message(child))[0].state).toBe("ready");
    const boundary = message(child);
    child.send({ command: input.command, publication_id: publication.publication_id, now: f.now.toISOString(), mode });
    const [paused] = await boundary; expect(paused.state).toBe("paused"); await stop(child);
    reopened = new AuthorityDb(f.db.filename);
    const completed = mode === "after_commit";
    expect(states(reopened)).toEqual({ request: { state: completed ? "completed" : "claimed" },
      attempt: { state: completed ? "confirmed" : "invoking" },
      workflow: { state: completed ? "completed" : "running", current_node: completed ? "complete" : "observe", attempts: completed ? 1 : 0 },
      receipts: { n: completed ? 1 : 0 }, events: { n: completed ? 1 : 0 } });
    expect(f.git(["rev-parse", publication.ref])).toBe(publication.commit);
    const before = reopened.db.prepare("SELECT total_changes() AS n").get();
    expect(readTaskCompletion(reopened, "execute")).toEqual(completed ? paused.result : null);
    expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    // Same still-valid published intent can settle after rollback; no model/verifier/ref operation is repeated.
    expect(await settleTaskExecution({ ...input, authority: reopened, publication_id: publication.publication_id })).toEqual(paused.result);
    expect(states(reopened).receipts).toEqual({ n: 1 });
    if (completed) expect(reopened.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { if (child) await stop(child); reopened?.close(); await f.cleanup(); }
}, 30_000);

it("two real processes produce one completion receipt and one workflow event", async () => {
  const f = await taskPublicationFixture(); const children: ChildProcess[] = [];
  try {
    const input = await f.certify(); const publication = await publishTaskGitCandidate(input);
    for (let i = 0; i < 2; i++) { const child = start(f.db.filename); children.push(child);
      expect((await message(child))[0].state).toBe("ready"); }
    const results = children.map(child => { const result = message(child);
      child.send({ command: input.command, publication_id: publication.publication_id, now: f.now.toISOString(), mode: "race" }); return result; });
    const messages = (await Promise.all(results)).map(([result]) => result);
    const successes = messages.filter(value => value.state === "completed");
    expect(successes.length).toBeGreaterThanOrEqual(1);
    for (const result of successes) expect(result.result).toEqual(readTaskCompletion(f.db, "execute"));
    // A loser whose current-authority check runs after COMMIT may fail closed instead of returning a replay.
    for (const result of messages.filter(value => value.state === "error")) expect(result.code).toMatch(/^TASK_/);
    expect(states(f.db)).toEqual({ request: { state: "completed" }, attempt: { state: "confirmed" },
      workflow: { state: "completed", current_node: "complete", attempts: 1 }, receipts: { n: 1 }, events: { n: 1 } });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM workflow_steps WHERE outcome='task_verified'").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM control_command_effects WHERE request_id='execute'").get()).toEqual({ n: 1 });
  } finally { for (const child of children) await stop(child); await f.cleanup(); }
}, 30_000);
