import { describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import {
  persistTask18Context,
  RECOMMENDATION_NOW,
  task18Request,
} from "../fixtures/recommendation-fixture.js";

async function database(): Promise<AuthorityDb> { const db = new AuthorityDb(tempDb()); await db.migrate(); return db; }
const protectedTables = [
  "control_command_requests", "work_items", "work_projection", "workflow_runs", "gjc_intents",
  "progress_observations", "live_supervisor_bindings",
] as const;
function count(value: unknown): number {
  if (typeof value !== "object" || value === null) throw new TypeError("count row required");
  return Number(Reflect.get(value, "count"));
}
function counts(db: AuthorityDb): Readonly<Record<string, number>> {
  return Object.fromEntries(protectedTables.map(table => [table, count(db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())]));
}

describe("Task 18 recommendation creation", () => {
  it("persists and projects exactly three ranked actions with one owner decision", async () => {
    // Given: an exact sufficient Task 15 context and ranked authority-free Task 17 output.
    const db = await database();
    try {
      const context = persistTask18Context(db); const service = new Recommendations(db); const before = counts(db);
      // When: the public boundary creates and exactly replays the recommendation.
      const request = task18Request(context); const created = service.create(request); const replay = service.create(request);
      const projection = service.project(RECOMMENDATION_NOW);
      // Then: rank, immutable digests, context evidence, and owner gating are retained without effects.
      expect(replay).toEqual(created);
      expect(projection.next_actions.map(action => [action.rank, action.title, action.state])).toEqual([
        [1, "Next: customer-delivery", "pending"], [2, "Next: worker-implementation", "pending"], [3, "Next: owner-gated-deploy", "pending"],
      ]);
      expect(projection.owner_decisions_needed.map(action => action.title)).toEqual(["Next: owner-gated-deploy"]);
      expect(new Set(projection.next_actions.map(action => action.canonical_digest))).toEqual(new Set([created.canonical_digest]));
      expect(new Set(projection.next_actions.map(action => action.evidence_digest))).toEqual(new Set([created.evidence_digest]));
      expect(projection).toMatchObject({ conflicts: ["calendar and customer dates differ"], omissions: ["mail unavailable"] });
      expect(counts(db)).toEqual(before);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM personal_recommendations").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("fails closed for changed replay identity, ranking evidence, action, approval, and confidence", async () => {
    // Given: one immutable recommendation identity.
    const db = await database();
    try {
      const context = persistTask18Context(db); const service = new Recommendations(db); const request = task18Request(context); service.create(request);
      const conflicts = [
        { ...request, actions: request.actions.map((action, index) => index === 0 ? { ...action, title: "Changed" } : action) },
        { ...request, ranking: { ...request.ranking, reason_codes: ["PRIORITY_RANKED", "PRIORITY_EXECUTABLE"] } },
        { ...request, confidence_class: "low" },
      ];
      // When/Then: every byte-changing replay conflicts, while weakening required approval is rejected at the boundary.
      for (const changed of conflicts) {
        expect(() => service.create(changed))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_IDENTITY_CONFLICT" }));
      }
      expect(() => service.create({ ...request, approval_requirement: "none" }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
    } finally { db.close(); }
  });

  it("rejects stale context, changed context digest, accessors, and execute-shaped input with zero effects", async () => {
    const db = await database();
    try {
      const context = persistTask18Context(db); const service = new Recommendations(db);
      const before = counts(db); const request = task18Request(context);
      expect(() => service.create({ ...request, context_digest: `sha256:${"f".repeat(64)}` }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EVIDENCE_CONFLICT" }));
      const executeActions = request.actions.map((action, index) => (
        index === 0 ? { ...action, operation: "execute" } : action
      ));
      expect(() => service.create({ ...request, actions: executeActions }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      const accessor = Object.defineProperty({}, "ranking", { get: () => request.ranking, enumerable: true });
      expect(() => service.create(accessor))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      const staleRanking = { ...request.ranking, generated_at: "2026-08-28T13:00:00.000Z" };
      expect(() => service.create({ ...request, ranking: staleRanking }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_CONTEXT_STALE" }));
      expect(counts(db)).toEqual(before);
    } finally { db.close(); }
  });
});
