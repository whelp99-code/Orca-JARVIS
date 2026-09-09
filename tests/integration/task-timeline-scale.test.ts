import { expect, it } from "vitest";
import { TaskTimelineGraphReader } from "../../src/task-timeline-graph.js";
import { TaskTimelineAuthorityEvents } from "../../src/task-timeline-authority-events.js";
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
    for (const id of ids) graph.controlIds.add(id);
    const events: unknown[] = [];
    new TaskTimelineAuthorityEvents(authority).add("task:scale", graph, event => events.push(event));
    expect(events).toEqual([]);
    expect(query.totalChanges()).toBe(before);
  } finally { authority.close(); }
}, 15000);
