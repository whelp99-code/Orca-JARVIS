import { expect, it } from "vitest";
import { TaskTimeline } from "../../src/task-timeline.js";
import { initialized } from "../helpers.js";

it("keeps the sorted tail and first occurrence after a duplicate leaves the retained tail", async () => {
  const authority = await initialized();
  try {
    authority.db.exec(`
      INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('a','task:tail','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z'),
             ('b','task:tail','dispatch','{}','sha256:b','b','pending','2026-09-09T23:00:00.000Z');
      INSERT INTO gjc_questions(question_id,intent_id,snapshot_json,snapshot_digest,state,created_at)
      VALUES ('gjc:b:state','a','{"origin":"first"}','sha256:q','open','2026-09-09T00:00:00.000Z');
    `);
    const insert = authority.db.prepare(`INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at)
      VALUES ('a','fixture.event','{}',?)`);
    authority.db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        // Traverse out of timestamp order, with ties resolved by event ID.
        insert.run(`2026-09-09T12:${String((i * 17) % 60).padStart(2, "0")}:00.000Z`);
      }
    })();
    const before = authority.db.prepare("SELECT total_changes() n").get() as { n: number };
    const timeline = new TaskTimeline(authority);
    const full = timeline.timeline("task:tail", 1000);
    expect(full).toHaveLength(602);
    expect(full.find(event => event.event_id === "gjc:b:state"))
      .toMatchObject({ title: "agent.question", payload: { origin: "first" } });
    for (const limit of [1, 1 + Number.EPSILON, 2, 1.5, 199.1, 200, 500, Number.NaN]) {
      const expected = full.slice(Math.max(0, full.length - limit)).map((event, index) => ({ ...event, sequence: index + 1 }));
      expect(timeline.timeline("task:tail", limit)).toEqual(expected);
    }
    expect(timeline.timeline("task:tail", 1)[0]?.title).toBe("fixture.event");
    expect(authority.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  } finally { authority.close(); }
});

it("keeps the later event when distinct Unicode IDs compare equal at the tail boundary", async () => {
  const authority = await initialized();
  try {
    authority.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('a','task:unicode','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z')`);
    const insert = authority.db.prepare(`INSERT INTO gjc_questions(question_id,intent_id,snapshot_json,snapshot_digest,state,created_at)
      VALUES (?,'a','{}','sha256:q','open','2026-09-09T01:00:00.000Z')`);
    insert.run("é");
    insert.run("e\u0301");
    expect("é".localeCompare("e\u0301")).toBe(0);
    const timeline = new TaskTimeline(authority);
    const full = timeline.timeline("task:unicode", 1000);
    expect(full.at(-1)?.event_id).toBe("é");
    expect(timeline.timeline("task:unicode", 1)).toEqual([{ ...full.at(-1), sequence: 1 }]);
  } finally { authority.close(); }
});
