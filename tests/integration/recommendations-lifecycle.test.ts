import { describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import {
  persistTask18Context, RECOMMENDATION_EXPIRES, RECOMMENDATION_ID, REPLACEMENT_ID, task18Request,
} from "../fixtures/recommendation-fixture.js";

async function setup() {
  const db = new AuthorityDb(tempDb()); await db.migrate(); const context = persistTask18Context(db);
  const service = new Recommendations(db); const first = service.create(task18Request(context));
  return { db, context, service, first };
}

describe("Task 18 recommendation lifecycle", () => {
  it("records acceptance as authority-free selection and exact replay without execution", async () => {
    // Given: a pending evidence-bound action.
    const { db, service, first } = await setup();
    try {
      const transition = {
        recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
        evidence_digest: first.evidence_digest, occurred_at: "2026-08-28T12:30:00.000Z",
      };
      // When: acceptance is appended and exactly replayed.
      service.transition(transition); service.transition(transition); const projected = service.project("2026-08-28T12:30:00.000Z");
      // Then: it remains current selection for Task 25 but cannot execute.
      expect(projected.next_actions[0]).toMatchObject({ state: "accepted", current: true, executable: false });
      const states = db.getPersonalRecommendation(first.recommendation.id)?.action_events
        .filter(event => event["rank"] === 1).map(event => event["state"]);
      expect(states).toEqual(["pending", "accepted"]);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("removes rejected actions from current projection and rejects changed evidence or a second terminal state", async () => {
    const { db, service, first } = await setup();
    try {
      expect(() => service.transition({
        recommendation_id: RECOMMENDATION_ID, rank: 1, state: "rejected",
        evidence_digest: `sha256:${"f".repeat(64)}`, occurred_at: "2026-08-28T12:20:00.000Z",
      })).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EVIDENCE_CONFLICT" }));
      service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "rejected",
        evidence_digest: first.evidence_digest, occurred_at: "2026-08-28T12:20:00.000Z" });
      expect(service.project("2026-08-28T12:20:00.000Z").next_actions.map(action => action.rank)).toEqual([2, 3]);
      expect(() => service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
        evidence_digest: first.evidence_digest, occurred_at: "2026-08-28T12:21:00.000Z" }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_TRANSITION_CONFLICT" }));
    } finally { db.close(); }
  });

  it("enforces the effective deadline for expiry and all non-expiry transitions", async () => {
    const early = await setup();
    try {
      expect(() => early.service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "expired",
        evidence_digest: early.first.evidence_digest, occurred_at: "2026-08-28T12:59:59.998Z" }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_TRANSITION_CONFLICT" }));
      early.service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "expired",
        evidence_digest: early.first.evidence_digest, occurred_at: "2026-08-28T12:59:59.999Z" });
      expect(early.service.project(RECOMMENDATION_EXPIRES)).toMatchObject({ next_actions: [], warnings: [{ code: "RECOMMENDATION_EXPIRED" }] });
    } finally { early.db.close(); }
    const late = await setup();
    try {
      expect(() => late.service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
        evidence_digest: late.first.evidence_digest, occurred_at: RECOMMENDATION_EXPIRES }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EXPIRED" }));
    } finally { late.db.close(); }
  });

  it("binds supersession to an exact persisted replacement context and evidence digest", async () => {
    const { db, context, service, first } = await setup();
    try {
      const replacement = service.create(task18Request(context, REPLACEMENT_ID));
      const transition = { recommendation_id: RECOMMENDATION_ID, rank: 1, state: "superseded", evidence_digest: first.evidence_digest,
        occurred_at: "2026-08-28T12:30:00.000Z", replacement_recommendation_id: REPLACEMENT_ID,
        replacement_context_digest: replacement.recommendation.payload.context_digest,
        replacement_evidence_digest: replacement.evidence_digest, replacement_identity_digest: replacement.identity_digest };
      expect(() => service.transition({
        ...transition, replacement_evidence_digest: `sha256:${"f".repeat(64)}`,
      })).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_SUPERSESSION_CONFLICT" }));
      service.transition(transition); service.transition(transition);
      const remaining = service.project("2026-08-28T12:30:00.000Z").next_actions
        .filter(action => action.recommendation_id === RECOMMENDATION_ID).map(action => action.rank);
      expect(remaining).toEqual([2, 3]);
      const event = db.getPersonalRecommendation(first.recommendation.id)?.action_events.at(-1);
      expect(event?.["evidence_digest"]).not.toBe(first.evidence_digest);
      const projected = service.project("2026-08-28T12:30:00.000Z", 100);
      const superseded = projected.lifecycle_actions
        .find(action => action.recommendation_id === RECOMMENDATION_ID && action.rank === 1);
      expect(superseded).toMatchObject({ state: "superseded", replacement_recommendation_id: REPLACEMENT_ID });
      expect(projected.next_actions.find(action => action.recommendation_id === REPLACEMENT_ID)?.identity_digest)
        .toBe(replacement.identity_digest);
    } finally { db.close(); }
  });
});
