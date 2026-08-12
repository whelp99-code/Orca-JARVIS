import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, LiveSupervisor, PreGjcShadow, TaskTimeline, buildCurrentState, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/index.js";
import { execute } from "../../src/cli.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { evidenceFor, future, initialized, localKey, policyKey, snapshot, tempDb } from "../helpers.js";

const request = (requestId: string, action: string, actionLevel: 0 | 1 | 2 | 3 | 4 | 5, args: Record<string, unknown>, target: Record<string, unknown> = { task_id: "task:timeline" }): ControlCommandRequestInput => {
  const requestedAt = new Date().toISOString();
  return { schema_version: 1, request_id: requestId, action, action_level: actionLevel, target, args, reversible: true, requested_by: "test-operator", requested_at: requestedAt, expires_at: future(10), nonce: `nonce:${requestId}` };
};

const approve = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput): void => {
  const staged = control.stage(input); const issuedAt = new Date().toISOString();
  const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval:${input.request_id}`, request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: issuedAt, not_before: issuedAt, expires_at: input.expires_at, nonce: `receipt:${input.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(payload, localKey(db)));
};

describe("Buzz-inspired read-only task timeline", () => {
  it("projects existing approvals, workflow steps, evidence references, and pending decisions without creating a second collaboration store", async () => {
    const db = await initialized(); new LoopGraph(db).ensureDefaults(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db);
    const start = request("request:timeline:start", "workflow.start", 2, { run_id: "run:timeline", loop_id: "agentops-default", correlation_id: "task:timeline", input: { task_id: "task:timeline", objective: "Show one task timeline" }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: future(30) } });
    approve(db, control, start); expect((await executor.execute(start.request_id)).state).toBe("completed");
    const advance = request("request:timeline:advance", "workflow.advance", 2, { task_id: "task:timeline", run_id: "run:timeline", outcome: "observed", output: { summary: "Orca and GJC state collected" }, evidence_digest: "sha256:timeline-observation" });
    approve(db, control, advance); expect((await executor.execute(advance.request_id)).state).toBe("completed");
    const pending = request("request:timeline:push", "git.push", 4, { task_id: "task:timeline", branch: "main" }); control.stage(pending);

    const beforeReads = Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
    const timeline = new TaskTimeline(db); const tasks = timeline.list(); const task = tasks.find(item => item.task_id === "task:timeline");
    expect(task).toMatchObject({ task_id: "task:timeline", pending_approval: true });
    expect(task?.source_ids).toEqual(expect.arrayContaining([start.request_id, advance.request_id, pending.request_id, "run:timeline"]));
    const events = timeline.timeline("task:timeline");
    expect(events.map(item => item.title)).toEqual(expect.arrayContaining(["control.command.requested", "approval.approve", "workflow.started", "workflow.observe", "workflow.started"]));
    expect(events.some(item => item.source === "workflow" && item.evidence_refs.includes("sha256:timeline-observation"))).toBe(true);
    const context = timeline.context("task:timeline", 100, 128 * 1024);
    expect(context.pending_decisions).toContainEqual(expect.objectContaining({ kind: "command", request_id: pending.request_id, action: "git.push" }));
    expect(context.events.length).toBeGreaterThan(5); expect(context.truncated).toBe(false);
    expect(Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count)).toBe(beforeReads);
    const state = await buildCurrentState(db); expect(state.now).toMatchObject({ task_timelines: 1, task_timelines_pending_approval: 1 }); expect(state.now).not.toHaveProperty("collaboration_rooms");

    const filename = db.filename; db.close();
    await expect(execute(["timeline", "list", "--db", filename])).resolves.toMatchObject({ command: "timeline.list" });
    await expect(execute(["timeline", "show", "task:timeline", "--db", filename])).resolves.toMatchObject({ command: "timeline.show", task_id: "task:timeline" });
    await expect(execute(["timeline", "context", "task:timeline", "--db", filename])).resolves.toMatchObject({ command: "timeline.context", task_id: "task:timeline" });
    await expect(execute(["capabilities", "--json", "--db", filename])).resolves.toMatchObject({ task_timeline: true, collaboration_workspace: false, buzz_bridge: false });
  });

  it("resolves an exact task even when it is older than 500 recent GJC items", async () => {
    const db = new (await import("../../src/db.js")).AuthorityDb(tempDb()); await db.migrate();
    const insert = db.db.prepare("INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at) VALUES(?,?,?,?,?,?,?,?)");
    db.db.transaction(() => {
      insert.run("gjc-exact-old", "task:exact-old", "dispatch", "{}", "sha256:old", "exact-old", "pending", "2026-08-01T00:00:00.000Z");
      for (let index = 0; index < 500; index++) insert.run(`gjc-recent-${index}`, `task:recent-${index}`, "dispatch", "{}", `sha256:recent-${index}`, `recent-${index}`, "pending", `2026-08-02T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`);
    })();
    let context: ReturnType<TaskTimeline["context"]> | undefined;
    expect(() => { context = new TaskTimeline(db).context("task:exact-old", 20, 128 * 1024, new Date("2026-08-12T00:00:00.000Z")); }).not.toThrow();
    expect(context?.task).toMatchObject({ task_id: "task:exact-old", source_ids: ["gjc-exact-old"] });
    db.close();
  });

  it("keeps a requested 600-event context when it is under the byte budget", async () => {
    const db = await initialized(); const source = snapshot("codex", { authorization: "both" }); db.ingest(source, policyKey(db));
    const insert = db.db.prepare("INSERT INTO event_ledger(work_id,event_type,payload_json,created_at) VALUES(?,?,?,?)");
    db.db.transaction(() => { for (let index = 0; index < 600; index++) insert.run("codex-work", `bulk-${String(index).padStart(3, "0")}`, "{}", `2026-08-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`); })();
    const context = new TaskTimeline(db).context("codex-work", 600, 1024 * 1024, new Date("2026-08-12T00:00:00.000Z"));
    expect(context.events.filter(event => event.title.startsWith("bulk-"))).toHaveLength(600);
    expect(context.truncated).toBe(false); db.close();
  });

  it("canonically composes work, GJC, progress, verification, and binding records", async () => {
    const db = await initialized(); const source = snapshot("codex", { authorization: "code" }); db.ingest(source, policyKey(db)); db.workerOnce(); db.workerOnce(); db.recordVerification(evidenceFor(db, "codex-work"));
    const continuation = (db.db.prepare("SELECT id FROM continuation_acceptances WHERE work_id='codex-work'").get() as { id: string }).id;
    db.configureGjc(dirname(db.filename), "timeline-session", true); db.createGjcIntent("dispatch", { cwd: dirname(db.filename), session_id: "timeline-session" }, "timeline-composition", continuation, "2026-08-11T00:00:00.000Z");
    const supervisor = new LiveSupervisor(db); supervisor.register({ worktree: dirname(db.filename), provider: "codex", terminal_id: "terminal-composed", session_id: "session-composed", incarnation_id: "incarnation-composed", pty_id: "pty-composed", worktree_id: "main", project_id: "codex-project" }, "2026-08-11T00:00:01.000Z");
    db.stageProgressBatch({ version: 1, worktree: dirname(db.filename), observed_at: "2026-08-11T00:00:02.000Z", assessments: [{ provider: "codex", terminal_id: "terminal-composed", incarnation_id: "incarnation-composed", cursor: "cursor-composed", observation_identity: `sha256:${"a".repeat(64)}`, state: "verifying" }] });
    const timeline = new TaskTimeline(db); const events = timeline.timeline("codex-work", 1000); const context = timeline.context("codex-work", 1000, 1024 * 1024, new Date("2026-08-12T00:00:00.000Z"));
    expect(new Set(events.map(event => event.source))).toEqual(new Set(["work", "gjc", "progress", "verification"]));
    expect(context.workers).toContainEqual(expect.objectContaining({ terminal_id: "terminal-composed", worktree_id: "main" })); db.close();
  });

  it("isolates colliding terminal handles by canonical worktree binding", async () => {
    const db = await initialized(); db.ingest(snapshot("codex", { authorization: "both" }), policyKey(db));
    const first = dirname(db.filename); const second = dirname(tempDb()); const supervisor = new LiveSupervisor(db);
    supervisor.register({ worktree: first, provider: "codex", terminal_id: "shared-terminal", session_id: "session-a", incarnation_id: "incarnation-a", worktree_id: "main", project_id: "codex-project" });
    supervisor.register({ worktree: second, provider: "codex", terminal_id: "shared-terminal", session_id: "session-b", incarnation_id: "incarnation-b", worktree_id: "other", project_id: "other-project" });
    db.stageProgressBatch({ version: 1, worktree: first, observed_at: "2026-08-11T00:00:00.000Z", assessments: [{ provider: "codex", terminal_id: "shared-terminal", incarnation_id: "incarnation-a", cursor: "a", observation_identity: `sha256:${"b".repeat(64)}`, state: "running" }] });
    db.markProgressDelivered(db.pendingProgressReport()!.report_id, "2026-08-11T00:00:01.000Z");
    db.stageProgressBatch({ version: 1, worktree: second, observed_at: "2026-08-11T00:00:02.000Z", assessments: [{ provider: "codex", terminal_id: "shared-terminal", incarnation_id: "incarnation-b", cursor: "b", observation_identity: `sha256:${"c".repeat(64)}`, state: "needs_input" }] });
    const progress = new TaskTimeline(db).timeline("codex-work", 1000).filter(event => event.source === "progress");
    expect(progress.map(event => event.event_id)).toEqual([`sha256:${"b".repeat(64)}`]); db.close();
  });

  it("surfaces staged project correlation only as proposed and untrusted", async () => {
    const db = await initialized(); db.ingest(snapshot("codex", { authorization: "both" }), policyKey(db)); const shadow = new PreGjcShadow(db); shadow.configureProject("codex-project", "codex", 10, 10);
    const proposalId = shadow.proposeImprovement("codex-project", { task_id: "codex-work", summary: "agent-supplied correlation" });
    const proposed = new TaskTimeline(db).timeline("codex-work", 1000).find(event => event.event_id === proposalId);
    expect(proposed).toMatchObject({ title: "correlation.proposed", status: "untrusted", payload: { project_id: "codex-project", trust: "untrusted" } }); db.close();
  });
});
