import { expect, it, vi } from "vitest";
import { TaskTimelineGraphReader } from "../../src/task-timeline-graph.js";
import { TaskTimelineAuthorityEvents } from "../../src/task-timeline-authority-events.js";
import { TaskTimeline } from "../../src/task-timeline.js";
import { TaskTimelineQuery } from "../../src/task-timeline-query.js";
import { initialized } from "../helpers.js";

it("reads a large connected timeline without exhausting SQLite bind parameters or writing", async () => {
  const authority = await initialized();
  try {
    const insert = authority.db.prepare("INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json," +
      "payload_digest,idempotency_key,state,created_at) VALUES(?,?,'dispatch','{}',?,?,'pending',?)");
    authority.db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run(`scale:${i}`, "task:scale", `sha256:${i}`, `scale:${i}`,
        "2026-09-09T00:00:00.000Z");
      insert.run("unrelated", "task:other", "sha256:other", "other", "2026-09-09T00:00:00.000Z");
    })();
    const query = new TaskTimelineQuery(authority);
    const before = query.totalChanges();
    const graph = new TaskTimelineGraphReader(authority).build("task:scale");
    expect(graph.intentIds.size).toBe(2000);
    expect(graph.intentIds.has("unrelated")).toBe(false);
    const ids = Array.from({ length: 40000 }, (_, i) => `scale:${i}`);
    const rows = query.inRows("SELECT intent_id FROM gjc_intents WHERE intent_id IN", ids, "ORDER BY intent_id");
    expect(rows).toHaveLength(2000);
    expect(rows.map(row => row.intent_id)).toEqual([...graph.intentIds].sort());
    const prepare = vi.spyOn(authority.db, "prepare");
    try {
      expect(new TaskTimeline(authority).timeline("task:scale", 200)).toHaveLength(200);
      expect(prepare.mock.calls.length).toBeLessThan(100);
    } finally { prepare.mockRestore(); }
    for (const id of ids) graph.controlIds.add(id);
    const events: unknown[] = [];
    new TaskTimelineAuthorityEvents(authority).add("task:scale", graph, event => events.push(event));
    expect(events).toEqual([]);
    expect(query.totalChanges()).toBe(before);
  } finally { authority.close(); }
}, 15000);

it("preserves parent-first event precedence and repeated control matches after batching", async () => {
  const authority = await initialized();
  try {
    authority.db.exec(`
      INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('a','task:batch','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z'),
             ('b','task:batch','dispatch','{}','sha256:b','b','pending','2026-09-09T00:00:00.000Z');
      INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at)
      VALUES ('a','transition.a','{}','2026-09-09T00:00:00.000Z');
      INSERT INTO gjc_dispatch_receipts(intent_id,session_id,turn_id,receipt_json,accepted_at)
      VALUES ('a','s','t','{}','2026-09-09T00:00:00.000Z');
      INSERT INTO gjc_answer_receipts(intent_id,session_id,turn_id,question_id,answer_binding_json,receipt_json,completed_at)
      VALUES ('a','s','t','q','{}','{}','2026-09-09T00:00:00.000Z');
      INSERT INTO gjc_questions(question_id,intent_id,snapshot_json,snapshot_digest,state,created_at)
      VALUES ('gjc:b:state','a','{"origin":"question"}','sha256:q','open','2026-09-09T00:00:00.000Z');
      INSERT INTO control_events(event_id,schema_version,event_type,source,subject,correlation_id,payload_json,payload_digest,created_at)
      VALUES ('control-both',1,'workflow.observed','fixture','task:batch','a','{}','sha256:c','2026-09-09T00:00:00.000Z'),
             ('control-same',1,'workflow.observed','fixture','task:batch','task:batch','{}','sha256:d','2026-09-09T00:00:00.000Z');
    `);
    const graph = new TaskTimelineGraphReader(authority).build("task:batch");
    const controls: string[] = [];
    new TaskTimelineAuthorityEvents(authority).add("task:batch", graph, event => controls.push(event.event_id));
    expect(controls).toEqual(["control-both", "control-same", "control-both"]);
    const { TaskTimelineRuntimeEvents } = await import("../../src/task-timeline-runtime-events.js");
    const titles: string[] = [];
    new TaskTimelineRuntimeEvents(authority).add("task:batch", graph, event => titles.push(event.title));
    expect(titles).toEqual(["gjc.dispatch", "transition.a", "gjc.dispatch.receipt", "gjc.answer.receipt", "agent.question", "gjc.dispatch"]);
    const events = new TaskTimeline(authority).timeline("task:batch");
    expect(events.filter(event => event.event_id === "control-both")).toHaveLength(1);
    expect(events.find(event => event.event_id === "gjc:b:state"))
      .toMatchObject({ title: "agent.question", payload: { origin: "question" } });
  } finally { authority.close(); }
});
