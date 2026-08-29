import { describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations, TaskTimeline } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import {
  persistTask18Context,
  RECOMMENDATION_ID,
  REPLACEMENT_ID,
  task18Request,
} from "../fixtures/recommendation-fixture.js";

async function setup() {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const context = persistTask18Context(db);
  return { db, context, service: new Recommendations(db) };
}

function clone(value: unknown): unknown { return structuredClone(value); }

describe("Task 18 frozen remediation", () => {
  it("rejects incomplete, open, accessor, and unrelated Task 17 results without reading getters", async () => {
    const { db, context, service } = await setup();
    try {
      const request = task18Request(context);
      const incomplete = { status: "ranked", authority: "none", effect: "none", generated_at: request.ranking.generated_at,
        policy_id: request.ranking.policy_id, actions: request.ranking.actions };
      expect(() => service.create({ ...request, ranking: incomplete }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_RANKING_INVALID" }));
      expect(() => service.create({ ...request, ranking: { ...request.ranking, unknown: true } }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_RANKING_INVALID" }));
      let reads = 0;
      const actions = [...request.ranking.actions];
      Object.defineProperty(actions, "0", { enumerable: true, get: () => { reads += 1; return request.ranking.actions[0]; } });
      expect(() => service.create({ ...request, ranking: { ...request.ranking, actions } }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_RANKING_INVALID" }));
      expect(reads).toBe(0);
      const unrelated = clone(request.ranking);
      if (typeof unrelated !== "object" || unrelated === null
        || !("actions" in unrelated) || !Array.isArray(unrelated.actions)) {
        throw new TypeError("ranking fixture required");
      }
      const first = unrelated.actions[0];
      if (typeof first !== "object" || first === null || !("rationale" in first)
        || typeof first.rationale !== "object" || first.rationale === null
        || !("citations" in first.rationale) || typeof first.rationale.citations !== "object"
        || first.rationale.citations === null) {
        throw new TypeError("citation fixture required");
      }
      first.rationale.citations = { ...first.rationale.citations, current_linux_evidence_ref: "live:unrelated" };
      expect(() => service.create({ ...request, ranking: unrelated }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EVIDENCE_CONFLICT" }));
    } finally { db.close(); }
  });

  it("rejects normalized effect segments, nested operations, and owner aggregate mismatch", async () => {
    const { db, context, service } = await setup();
    try {
      const request = task18Request(context);
      for (const operation of [" execute ", "foo.execute", "EXECUTE-command", "stage_work", "claim/redeem", "settle:now"]) {
        const actions = request.actions.map((action, index) => index === 0 ? { ...action, operation } : action);
        expect(() => service.create({ ...request, actions })).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      }
      expect(() => service.create({ ...request, metadata: { operation: "execute" } }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      const withoutOwner = { ...request.ranking, actions: request.ranking.actions.filter(action => action.disposition !== "owner_gate_required") };
      expect(() => service.create({ ...request, ranking: withoutOwner,
        actions: request.actions.filter(action => action.action_id !== "owner-gated-deploy") }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
    } finally { db.close(); }
  });

  it("strictly parses transition scalars and uses context freshness as the effective deadline", async () => {
    const { db, context, service } = await setup();
    try {
      const created = service.create(task18Request(context));
      const base = { recommendation_id: RECOMMENDATION_ID, state: "expired", evidence_digest: created.evidence_digest,
        occurred_at: context.freshness.fresh_until };
      for (const rank of ["1", 1.5, Number.NaN]) {
        expect(() => service.transition({ ...base, rank })).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      }
      expect(() => service.project("2026-99-99T99:99:99.999Z")).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      expect(() => service.project(context.freshness.fresh_until, 0)).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
      service.transition({ ...base, rank: 1 });
      expect(service.project(context.freshness.fresh_until).next_actions.some(action => action.rank === 1)).toBe(false);
    } finally { db.close(); }
  });

  it("requires a current replacement and keeps pending owner approval in timeline summary", async () => {
    const { db, context, service } = await setup();
    try {
      const first = service.create(task18Request(context));
      const replacement = service.create(task18Request(context, REPLACEMENT_ID));
      service.transition({ recommendation_id: REPLACEMENT_ID, rank: 1, state: "rejected",
        evidence_digest: replacement.evidence_digest, occurred_at: "2026-08-28T12:10:00.000Z" });
      expect(() => service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "superseded",
        evidence_digest: first.evidence_digest, occurred_at: "2026-08-28T12:20:00.000Z",
        replacement_recommendation_id: REPLACEMENT_ID,
        replacement_context_digest: replacement.recommendation.payload.context_digest,
        replacement_evidence_digest: replacement.evidence_digest,
        replacement_identity_digest: replacement.identity_digest }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_SUPERSESSION_CONFLICT" }));
      service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
        evidence_digest: first.evidence_digest, occurred_at: "2026-08-28T12:20:00.000Z" });
      const timeline = new TaskTimeline(db);
      expect(timeline.list().find(item => item.task_id === RECOMMENDATION_ID)?.pending_approval).toBe(true);
      expect(timeline.context(RECOMMENDATION_ID, 100, 128 * 1024, new Date("2026-08-28T12:20:00.000Z")).pending_decisions).toHaveLength(1);
    } finally { db.close(); }
  });
});
