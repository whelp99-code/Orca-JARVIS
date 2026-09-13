import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityDb, ControlPlane, Recommendations } from "../../src/index.js";
import { TaskTimeline } from "../../src/recommendation-timeline.js";
import { TaskTimelinePopulation } from "../../src/task-timeline-population.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { initialized, policyKey, snapshot, tempDb } from "../helpers.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

const databases: AuthorityDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
});
async function database() {
  const db = new AuthorityDb(tempDb()); databases.push(db); await db.migrate(); return db;
}
function intent(db: AuthorityDb, id: string, taskId = id, state = "pending", at = RECOMMENDATION_NOW) {
  db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
    VALUES(?,?,'dispatch','{}',?,?,?,?)`).run(id, taskId, `digest:${id}`, `key:${id}`, state, at);
}
function hide(db: AuthorityDb, id: string) {
  db.db.prepare(`INSERT INTO memory_projection_quarantine(projection_kind,projection_id,component_id,reason_code,detected_at)
    VALUES('task_timeline',?,?,'lineage_unresolved',?)`).run(id, id, RECOMMENDATION_NOW);
}
function changes(db: AuthorityDb) { return db.db.prepare("SELECT total_changes() AS n").get(); }

describe("complete active task population", () => {
  it("counts 21 active tasks outside a latest page of 20 completed tasks without writing", async () => {
    const db = await database();
    for (let i = 0; i < 21; i++) intent(db, `old:${i}`);
    for (let i = 0; i < 25; i++) intent(db, `new:${String(i).padStart(2, '0')}`, undefined, "completed", "2026-08-29T12:00:00.000Z");
    const before = changes(db);
    const result = await new DashboardReadModel(db).overview(new Date(RECOMMENDATION_NOW));
    expect(result.cards.find(card => card.id === "active-work")?.value).toBe(21);
    expect(result.recent_tasks).toHaveLength(20);
    expect(result.recent_tasks.every(task => task.state === "completed")).toBe(true);
    expect(changes(db)).toEqual(before);
    for (let i = 0; i < 10; i++) hide(db, `new:${String(i).padStart(2, '0')}`);
    hide(db, "old:0");
    const filtered = new TaskTimeline(db).overview();
    expect(filtered.activeCount).toBe(20);
    expect(filtered.recent).toHaveLength(20);
    expect(filtered.recent.filter(task => task.state === "completed")).toHaveLength(15);
    expect(filtered.recent.some(task => task.task_id === "old:0")).toBe(false);
  });

  it("deduplicates continuation aliases and preserves work state after a newer completed GJC send", async () => {
    const db = await initialized(); databases.push(db);
    db.ingest(snapshot("codex", { authorization: "code" }), policyKey(db)); db.workerOnce(); db.workerOnce();
    const continuation = db.db.prepare("SELECT id FROM continuation_acceptances WHERE work_id='codex-work'").get() as { id: string };
    expect(new TaskTimeline(db).context(continuation.id).task.task_id).toBe("codex-work");
    intent(db, "send:1", continuation.id, "completed", "2026-12-01T00:00:00.000Z");
    intent(db, "send:2", continuation.id, "completed", "2026-12-02T00:00:00.000Z");
    // The same source ID in another family must not duplicate the work's source list.
    intent(db, "codex-work", continuation.id, "completed", "2026-12-01T00:00:00.000Z");
    const timeline = new TaskTimeline(db); const result = timeline.overview();
    expect(result.activeCount).toBe(1); expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({ task_id: "codex-work", kind: "work", state: "awaiting_verification",
      source_ids: ["codex-work", "send:1", "send:2"] });
    expect(timeline.context(continuation.id).task).toEqual(timeline.context("codex-work").task);
    hide(db, "send:1");
    expect(timeline.overview()).toEqual({ activeCount: 0, recent: [] });
    for (const id of ["codex-work", continuation.id, "send:1", "send:2"]) {
      expect(() => timeline.context(id)).toThrow("TASK_TIMELINE_NOT_FOUND");
    }
  });

  it("normalizes workflow input and command run aliases to one task", async () => {
    const db = await database(); const graph = new LoopGraph(db); graph.ensureDefaults();
    const run = graph.start({ run_id: "run:count", loop_id: "agentops-default", correlation_id: "correlation:different",
      input: { task_id: "task:count" }, budget: { max_steps: 8, max_attempts_per_node: 2,
        deadline: "2026-08-28T13:00:00.000Z" } }, new Date(RECOMMENDATION_NOW));
    new ControlPlane(db).stage({ schema_version: 1, request_id: "request:count", action: "workflow.advance", action_level: 2,
      target: { run_id: run.run_id }, args: { run_id: run.run_id, outcome: "observed" }, reversible: true,
      requested_by: "test", requested_at: RECOMMENDATION_NOW, expires_at: "2026-08-28T13:00:00.000Z",
      nonce: "nonce:count" }, new Date(RECOMMENDATION_NOW));
    new ControlPlane(db).stage({ schema_version: 1, request_id: "request:start", action: "workflow.start", action_level: 2,
      target: { run_id: run.run_id, correlation_id: run.correlation_id }, args: { run_id: run.run_id,
        loop_id: run.loop_id, correlation_id: run.correlation_id, input: run.input, budget: run.budget }, reversible: true,
      requested_by: "test", requested_at: RECOMMENDATION_NOW, expires_at: "2026-08-28T13:00:00.000Z",
      nonce: "nonce:start" }, new Date(RECOMMENDATION_NOW));
    const timeline = new TaskTimeline(db); const result = timeline.overview();
    expect(result.activeCount).toBe(1); expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({ task_id: "task:count", kind: "workflow", state: run.state, pending_approval: true });
    expect(result.recent[0]?.source_ids).toEqual(["request:count", "request:start", "run:count"]);
    expect(timeline.context("request:count").task).toEqual(result.recent[0]);
    expect(timeline.context("correlation:different").task).toEqual(result.recent[0]);
    hide(db, "correlation:different");
    expect(timeline.overview()).toEqual({ activeCount: 0, recent: [] });
  });

  it("keeps complete sorted sources for selected tasks across page limits and source suppression", async () => {
    const db = await database();
    const ids = Array.from({ length: 501 }, (_, i) => `task:${String(i).padStart(3, "0")}`);
    const sources = ["中", "a", "Z", "é", "!"];
    db.db.transaction(() => {
      for (const id of ids) for (const source of sources) intent(db, `${id}:${source}`, id);
    })();
    const timeline = new TaskTimeline(db); const before = changes(db);
    const expected = (visible: string[], limit: number) => visible.slice(0, limit).map(id => ({
      task_id: id, source_ids: sources.map(source => `${id}:${source}`)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    }));
    for (const limit of [1, 20, 500]) {
      const result = timeline.overview(limit);
      expect(result.activeCount).toBe(501);
      expect(result.recent.map(({ task_id, source_ids }) => ({ task_id, source_ids }))).toEqual(expected(ids, limit));
    }
    expect(changes(db)).toEqual(before);
    hide(db, "task:000:é");
    const suppressed = timeline.overview(500);
    expect(suppressed.activeCount).toBe(500);
    expect(suppressed.recent.map(({ task_id, source_ids }) => ({ task_id, source_ids }))).toEqual(expected(ids.slice(1), 500));
  });

  it("uses one snapshot when another connection commits between base population and recommendation reads", async () => {
    const db = await database(); intent(db, "before");
    const writer = new AuthorityDb(db.filename);
    try {
      const original = TaskTimelinePopulation.prototype.overview;
      vi.spyOn(TaskTimelinePopulation.prototype, "overview").mockImplementationOnce(function(this: TaskTimelinePopulation, ...args) {
        const result = original.apply(this, args); intent(writer, "during"); return result;
      });
      expect(new TaskTimeline(db).overview()).toMatchObject({ activeCount: 1, recent: [{ task_id: "before" }] });
      expect(new TaskTimeline(db).overview().activeCount).toBe(2);
    } finally { writer.close(); }
  });

  it("does not merge ambiguous correlation aliases but propagates their suppression", async () => {
    const db = await database(); const graph = new LoopGraph(db); graph.ensureDefaults();
    for (const id of ["first", "second"]) graph.start({ run_id: `run:${id}`, loop_id: "agentops-default",
      correlation_id: "shared:correlation", input: { task_id: `task:${id}` },
      budget: { max_steps: 8, max_attempts_per_node: 2, deadline: "2026-08-28T13:00:00.000Z" } }, new Date(RECOMMENDATION_NOW));
    const timeline = new TaskTimeline(db);
    expect(timeline.overview().activeCount).toBe(2);
    expect(() => timeline.context("shared:correlation")).toThrow("TASK_TIMELINE_NOT_FOUND");
    hide(db, "shared:correlation");
    expect(timeline.overview()).toEqual({ activeCount: 0, recent: [] });
  });

  it("counts a recommendation once while any ranked action remains active", async () => {
    const db = await database(); const context = await persistTask18Context(db); const service = new Recommendations(db);
    const created = service.create(task18Request(context));
    intent(db, "recommendation:send", RECOMMENDATION_ID);
    for (let i = 0; i < 21; i++) intent(db, `recent:${i}`, undefined, "pending", "2026-08-29T00:00:00.000Z");
    const timeline = new TaskTimeline(db);
    // The context's own two owner approvals are real control commands and appear here too.
    expect(timeline.overview()).toMatchObject({ activeCount: 24 });
    const transition = (rank: number) => service.transition({ recommendation_id: RECOMMENDATION_ID, rank, state: "rejected",
      evidence_digest: created.evidence_digest, occurred_at: "2026-08-28T12:01:00.000Z" });
    transition(1);
    expect(timeline.overview().activeCount).toBe(24);
    expect(timeline.context(RECOMMENDATION_ID).task.state).toBe("pending");
    transition(2); transition(3);
    expect(timeline.overview().activeCount).toBe(23);
    expect(timeline.context("recommendation:send").task).toEqual(timeline.context(RECOMMENDATION_ID).task);
    hide(db, "recommendation:send");
    expect(timeline.list(100).some(task => task.task_id === RECOMMENDATION_ID)).toBe(false);
    expect(() => timeline.context(RECOMMENDATION_ID)).toThrow("TASK_TIMELINE_NOT_FOUND");
  });

  it("hides an accepted continuation before any GJC intent refers to it", async () => {
    const db = await initialized(); databases.push(db);
    db.ingest(snapshot("codex", { authorization: "code" }), policyKey(db)); db.workerOnce();
    const continuation = db.db.prepare("SELECT id FROM continuation_acceptances WHERE work_id='codex-work'").get() as { id: string };
    hide(db, continuation.id);
    expect(new TaskTimeline(db).overview()).toEqual({ activeCount: 0, recent: [] });
  });

  it("rejects invalid recommendation evidence outside the recent page", async () => {
    const db = await database(); const context = await persistTask18Context(db);
    new Recommendations(db).create(task18Request(context));
    for (let i = 0; i < 21; i++) intent(db, `recent:${i}`, undefined, "pending", "2026-08-29T00:00:00.000Z");
    db.db.prepare(`INSERT INTO personal_recommendation_action_events
      (recommendation_id,rank,state,evidence_digest,occurred_at,transition_occurred_at,transition_digest)
      VALUES(?,1,'rejected',?,?,?,?)`).run(RECOMMENDATION_ID, `sha256:${"a".repeat(64)}`,
      "2026-08-28T12:01:00.000Z", "2026-08-28T12:01:00.000Z", `sha256:${"b".repeat(64)}`);
    expect(() => new TaskTimeline(db).overview()).toThrow("RECOMMENDATION_INPUT_INVALID");
  });

  it("uses SQLite binary tie order when recommendations and base tasks share a timestamp", async () => {
    const db = await database(); const context = await persistTask18Context(db);
    new Recommendations(db).create(task18Request(context));
    const ids = ["Z", "a", "_", "z", "A", "R", "r", "é", "中", "!", ...Array.from({ length: 20 }, (_, i) => `task:${i}`)];
    for (const id of ids) intent(db, id);
    const expected = [...ids, RECOMMENDATION_ID].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).slice(0, 20);
    expect(new TaskTimeline(db).overview().recent.map(task => task.task_id)).toEqual(expected);
  });
});
