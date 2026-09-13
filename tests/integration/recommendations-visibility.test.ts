import { describe, expect, it } from "vitest";
import { AuthorityDb, buildCurrentState, Recommendations, TaskTimeline } from "../../src/index.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { tempDb } from "../helpers.js";
import {
  persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request,
} from "../fixtures/recommendation-fixture.js";

function count(value: unknown): number {
  if (typeof value !== "object" || value === null) throw new TypeError("count row required");
  return Number(Reflect.get(value, "count"));
}
function rank(value: unknown): number | undefined {
  return typeof value === "object" && value !== null ? Number(Reflect.get(value, "rank")) : undefined;
}

describe("Task 18 read-only composition", () => {
  it("exposes recommendation projection in current state with deterministic bounded rank order", async () => {
    // Given: three ranked actions with one owner gate.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const context = await persistTask18Context(db); new Recommendations(db).create(task18Request(context));
      const before = count(db.db.prepare("SELECT total_changes() AS count").get());
      // When: current state composes the recommendation read model.
      const state = await buildCurrentState(db, new Date(RECOMMENDATION_NOW));
      // Then: NEXT 3, decisions, conflicts, omissions, and immutable digest projection are visible without writes.
      expect(state.next_3.map(rank)).toEqual([1, 2, 3]);
      expect(state.decisions).toEqual([expect.objectContaining({ rank: 3, owner_decision_required: true, executable: false })]);
      expect(state.recommendations).toMatchObject({ conflicts: ["calendar and customer dates differ"], omissions: ["mail unavailable"] });
      expect(count(db.db.prepare("SELECT total_changes() AS count").get())).toBe(before);
    } finally { db.close(); }
  });

  it("publishes recommendation lifecycle events through timeline and dashboard task reads", async () => {
    // Given: one created recommendation and its three append-only pending events.
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const context = await persistTask18Context(db);
      new Recommendations(db).create(task18Request(context));
      const timeline = new TaskTimeline(db);
      // When: list, timeline, context, and dashboard consume the public read surface.
      const listed = timeline.list(10);
      const events = timeline.timeline(RECOMMENDATION_ID, 10);
      const detail = timeline.context(RECOMMENDATION_ID, 10, 128 * 1024, new Date(RECOMMENDATION_NOW));
      const dashboard = new DashboardReadModel(db);
      const dashboardDetail = dashboard.taskDetail(RECOMMENDATION_ID);
      // Then: deterministic evidence-bound events and the one owner decision are visible.
      expect(listed).toContainEqual(expect.objectContaining({ task_id: RECOMMENDATION_ID, kind: "recommendation", pending_approval: true }));
      expect(events).toHaveLength(3);
      expect(events.map(event => [event.sequence, event.source, event.status])).toEqual([
        [1, "recommendation", "pending"], [2, "recommendation", "pending"], [3, "recommendation", "pending"],
      ]);
      expect(events[0]).toMatchObject({
        evidence_refs: [expect.stringMatching(/^sha256:/)], payload: { authority: "none", executable: false },
      });
      expect(detail.pending_decisions).toEqual([expect.objectContaining({ rank: 3, executable: false })]);
      expect(dashboardDetail.kind).toBe("found");
      if (dashboardDetail.kind !== "found") throw new TypeError("dashboard recommendation detail required");
      expect(dashboardDetail.value.context.task.kind).toBe("recommendation");
      expect(dashboardDetail.value.context.events.every(event => event.source === "recommendation")).toBe(true);
    } finally { db.close(); }
  });
});
