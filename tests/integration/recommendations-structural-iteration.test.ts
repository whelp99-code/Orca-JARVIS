import { describe, expect, it } from "vitest";
import {
  AuthorityDb,
  buildCurrentState,
  RecommendationError,
  Recommendations,
  TaskTimeline,
} from "../../src/index.js";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import {
  supersessionEvidenceDigest,
  transitionDigest,
  type ReplacementRecommendationIdentity,
  type TerminalTransitionIdentity,
} from "../../src/recommendation-transition-identity.js";
import {
  persistTask18Context,
  RECOMMENDATION_ID,
  REPLACEMENT_ID,
  task18Request,
} from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

async function setup() {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const context = persistTask18Context(db);
  const service = new Recommendations(db);
  return { context, db, service };
}

function corruptProvenance(db: AuthorityDb, recommendationId: string): void {
  const row = db.db.prepare("SELECT canonical_envelope_json FROM personal_recommendations WHERE recommendation_id=?").get(recommendationId);
  if (typeof row !== "object" || row === null) throw new TypeError("stored recommendation required");
  const envelope = JSON.parse(String(Reflect.get(row, "canonical_envelope_json")));
  Reflect.set(Reflect.get(envelope, "payload"), "confidence_basis", "task18:v1:malformed");
  db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
  db.db.prepare("UPDATE personal_recommendations SET canonical_envelope_json=? WHERE recommendation_id=?")
    .run(JSON.stringify(envelope), recommendationId);
}

const PUBLIC_ERROR = {
  constructor: RecommendationError,
  name: "RecommendationError",
  message: "RECOMMENDATION_INPUT_INVALID",
  code: "RECOMMENDATION_INPUT_INVALID",
} as const;

function expectPublicRecommendationError(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining(PUBLIC_ERROR));
}

async function expectAsyncPublicRecommendationError(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    throw new TypeError("public recommendation error required");
  } catch (error) {
    if (!(error instanceof RecommendationError)) throw error;
    expect(error).toEqual(expect.objectContaining(PUBLIC_ERROR));
  }
}

function insertTerminal(db: AuthorityDb, input: TerminalTransitionIdentity,
  eventEvidence: string, storedDigest: string, recordedAt: string): void {
  db.db.prepare(
    `INSERT INTO personal_recommendation_action_events(
       recommendation_id,rank,state,evidence_digest,occurred_at,
       transition_occurred_at,transition_digest,replacement_recommendation_id
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(input.recommendation_id, input.rank, input.state, eventEvidence, recordedAt,
    input.occurred_at, storedDigest, input.replacement?.recommendation_id ?? null);
}

describe("Task 18 structural iteration 1", () => {
  it("preserves exact public transition time independently from compatibility recorded time", async () => {
    // Given
    const { context, db, service } = await setup();
    try {
      const created = service.create(task18Request(context));
      const exact = created.recommendation.freshness.fresh_until;
      const recorded = created.recommendation.expires_at;
      // When
      service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "expired",
        evidence_digest: created.evidence_digest, occurred_at: exact });
      const event = db.getPersonalRecommendation(created.recommendation.id)?.action_events.at(-1);
      // Then
      expect(event).toMatchObject({ occurred_at: exact, recorded_at: recorded,
        transition_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), replacement_recommendation_id: null });
      const audit = db.db.prepare(
        "SELECT subject_digest,occurred_at FROM personal_context_audit_events WHERE subject_id=?",
      ).get(`${RECOMMENDATION_ID}:1:expired`);
      expect(audit).toEqual({ subject_digest: event?.["transition_digest"], occurred_at: exact });
      expect(() => service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "expired",
        evidence_digest: created.evidence_digest, occurred_at: recorded }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_TRANSITION_CONFLICT" }));
    } finally { db.close(); }
  });

  it("replays exact supersession after the replacement later becomes terminal", async () => {
    // Given
    const { context, db, service } = await setup();
    try {
      const source = service.create(task18Request(context));
      const replacement = service.create(task18Request(context, REPLACEMENT_ID));
      const transition = { recommendation_id: RECOMMENDATION_ID, rank: 1, state: "superseded",
        evidence_digest: source.evidence_digest, occurred_at: "2026-08-28T12:30:00.000Z",
        replacement_recommendation_id: REPLACEMENT_ID,
        replacement_context_digest: replacement.recommendation.payload.context_digest,
        replacement_evidence_digest: replacement.evidence_digest,
        replacement_identity_digest: replacement.identity_digest } as const;
      service.transition(transition);
      service.transition({ recommendation_id: REPLACEMENT_ID, rank: 1, state: "rejected",
        evidence_digest: replacement.evidence_digest, occurred_at: "2026-08-28T12:31:00.000Z" });
      // When / Then
      expect(() => service.transition(transition)).not.toThrow();
      expect(service.project("2026-08-28T12:31:00.000Z", 1).lifecycle_actions[0])
        .toMatchObject({ recommendation_id: RECOMMENDATION_ID, replacement_recommendation_id: REPLACEMENT_ID });
    } finally { db.close(); }
  });

  it("uses one stable typed error across every public recommendation read surface", async () => {
    // Given
    const { context, db, service } = await setup();
    try {
      const created = service.create(task18Request(context));
      corruptProvenance(db, RECOMMENDATION_ID);
      const timeline = new TaskTimeline(db);
      const dashboard = new DashboardReadModel(db);
      // When / Then
      expectPublicRecommendationError(() => service.project("2026-08-28T12:10:00.000Z"));
      expectPublicRecommendationError(() => db.getPersonalRecommendation(created.recommendation.id));
      expectPublicRecommendationError(() => timeline.list(10));
      expectPublicRecommendationError(() => timeline.timeline(RECOMMENDATION_ID, 10));
      expectPublicRecommendationError(() => timeline.context(RECOMMENDATION_ID, 10));
      await expect(buildCurrentState(db, new Date("2026-08-28T12:10:00.000Z"))).rejects.toBeInstanceOf(RecommendationError);
      await expect(dashboard.overview(new Date("2026-08-28T12:10:00.000Z"))).rejects.toBeInstanceOf(RecommendationError);
      expectPublicRecommendationError(() => dashboard.listTasks(10));
      expectPublicRecommendationError(() => dashboard.taskDetail(RECOMMENDATION_ID));
    } finally { db.close(); }
  });

  it("rejects well-shaped incorrect transition identity and event evidence for every terminal class", async () => {
    const states = ["accepted", "rejected", "expired", "superseded", "dismissed"] as const;
    for (const state of states) {
      // Given
      const { context, db, service } = await setup();
      try {
        const source = service.create(task18Request(context));
        const replacement = state === "accepted" || state === "superseded"
          ? service.create(task18Request(context, REPLACEMENT_ID)) : undefined;
        const replacementIdentity: ReplacementRecommendationIdentity | null = state !== "superseded"
          || replacement === undefined ? null : {
          recommendation_id: replacement.recommendation.id,
          context_digest: replacement.recommendation.payload.context_digest,
          evidence_digest: replacement.evidence_digest,
          identity_digest: replacement.identity_digest,
        };
        const occurredAt = state === "expired" ? source.recommendation.freshness.fresh_until : "2026-08-28T12:20:00.000Z";
        const identity: TerminalTransitionIdentity = { recommendation_id: source.recommendation.id, rank: 1, state,
          evidence_digest: source.evidence_digest, occurred_at: occurredAt, replacement: replacementIdentity };
        const eventEvidence = replacementIdentity === null ? source.evidence_digest
          : supersessionEvidenceDigest(source.evidence_digest, replacementIdentity);
        let wrongIdentity: TerminalTransitionIdentity;
        switch (state) {
          case "accepted":
            if (replacement === undefined) throw new TypeError("replacement control required");
            wrongIdentity = { ...identity, recommendation_id: replacement.recommendation.id };
            break;
          case "rejected": wrongIdentity = { ...identity, rank: 2 }; break;
          case "expired": wrongIdentity = { ...identity, occurred_at: source.recommendation.expires_at }; break;
          case "superseded":
            if (replacementIdentity === null) throw new TypeError("replacement identity required");
            wrongIdentity = { ...identity, replacement: { ...replacementIdentity,
              context_digest: source.evidence_digest } };
            break;
          case "dismissed": wrongIdentity = { ...identity, state: "snoozed" }; break;
          default: state satisfies never; throw new TypeError("terminal control required");
        }
        // When
        insertTerminal(db, identity, eventEvidence, transitionDigest(wrongIdentity),
          state === "expired" ? source.recommendation.expires_at : occurredAt);
        // Then
        expectPublicRecommendationError(() => state === "dismissed"
          ? db.getPersonalRecommendation(source.recommendation.id)
          : service.project("2026-08-28T12:30:00.000Z"));
      } finally { db.close(); }
    }

    const { context, db, service } = await setup();
    try {
      const source = service.create(task18Request(context));
      const identity: TerminalTransitionIdentity = { recommendation_id: source.recommendation.id, rank: 1,
        state: "accepted", evidence_digest: source.evidence_digest, occurred_at: "2026-08-28T12:20:00.000Z", replacement: null };
      insertTerminal(db, identity, `sha256:${"b".repeat(64)}`, transitionDigest(identity), identity.occurred_at);
      expectPublicRecommendationError(() => service.project("2026-08-28T12:30:00.000Z"));
    } finally { db.close(); }
  });

  it("uses the exact shared error for corrupt event identity across every decoding read surface", async () => {
    // Given
    const { context, db, service } = await setup();
    try {
      const source = service.create(task18Request(context));
      const identity: TerminalTransitionIdentity = { recommendation_id: source.recommendation.id, rank: 1,
        state: "accepted", evidence_digest: source.evidence_digest, occurred_at: "2026-08-28T12:20:00.000Z", replacement: null };
      insertTerminal(db, identity, source.evidence_digest, `sha256:${"c".repeat(64)}`, identity.occurred_at);
      const timeline = new TaskTimeline(db);
      const dashboard = new DashboardReadModel(db);
      // When / Then
      expectPublicRecommendationError(() => service.project("2026-08-28T12:30:00.000Z"));
      expectPublicRecommendationError(() => db.getPersonalRecommendation(source.recommendation.id));
      expectPublicRecommendationError(() => timeline.list(10));
      expectPublicRecommendationError(() => timeline.timeline(RECOMMENDATION_ID, 10));
      expectPublicRecommendationError(() => timeline.context(RECOMMENDATION_ID, 10));
      await expectAsyncPublicRecommendationError(() => buildCurrentState(db, new Date("2026-08-28T12:30:00.000Z")));
      await expectAsyncPublicRecommendationError(() => dashboard.overview(new Date("2026-08-28T12:30:00.000Z")));
      expectPublicRecommendationError(() => dashboard.listTasks(10));
      expectPublicRecommendationError(() => dashboard.taskDetail(RECOMMENDATION_ID));
    } finally { db.close(); }
  });

  it("does not relabel an operational SQLite failure", async () => {
    // Given
    const { context, db, service } = await setup();
    service.create(task18Request(context));
    db.close();
    // When / Then
    try {
      service.project("2026-08-28T12:30:00.000Z");
      throw new TypeError("closed database failure required");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      expect(error).not.toBeInstanceOf(RecommendationError);
    }
  });

  it("accepts exact identity for all terminal variants readable through their public level", async () => {
    const states = ["accepted", "rejected", "expired", "superseded", "dismissed", "snoozed"] as const;
    for (const state of states) {
      // Given
      const { context, db, service } = await setup();
      try {
        const source = service.create(task18Request(context));
        const replacement = state === "superseded" ? service.create(task18Request(context, REPLACEMENT_ID)) : undefined;
        const replacementIdentity: ReplacementRecommendationIdentity | null = replacement === undefined ? null : {
          recommendation_id: replacement.recommendation.id,
          context_digest: replacement.recommendation.payload.context_digest,
          evidence_digest: replacement.evidence_digest,
          identity_digest: replacement.identity_digest,
        };
        const occurredAt = state === "expired" ? source.recommendation.freshness.fresh_until : "2026-08-28T12:20:00.000Z";
        const identity: TerminalTransitionIdentity = { recommendation_id: source.recommendation.id, rank: 1, state,
          evidence_digest: source.evidence_digest, occurred_at: occurredAt, replacement: replacementIdentity };
        const eventEvidence = replacementIdentity === null ? source.evidence_digest
          : supersessionEvidenceDigest(source.evidence_digest, replacementIdentity);
        // When
        insertTerminal(db, identity, eventEvidence, transitionDigest(identity),
          state === "expired" ? source.recommendation.expires_at : occurredAt);
        // Then
        expect(() => db.getPersonalRecommendation(source.recommendation.id)).not.toThrow();
        expect(() => new TaskTimeline(db).timeline(RECOMMENDATION_ID, 10)).not.toThrow();
        if (state !== "dismissed" && state !== "snoozed") {
          expect(() => service.project("2026-08-28T12:30:00.000Z")).not.toThrow();
        }
      } finally { db.close(); }
    }
  });
});
