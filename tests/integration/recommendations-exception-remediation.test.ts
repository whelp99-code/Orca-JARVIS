import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations } from "../../src/index.js";
import {
  persistTask18Context,
  RECOMMENDATION_ID,
  task18EvidenceForReference,
  task18Request,
} from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

const CITATION_SLOTS = [
  "confirmed_principle_ref",
  "confirmed_principle_evidence_ref",
  "linux_policy_decision_ref",
  "owner_import_decision_ref",
  "current_linux_evidence_ref",
  "deadline_evidence_ref",
  "dependency_evidence_ref",
  "owner_gate_ref",
  "stable_identity_evidence_ref",
] as const;
const IDS = [
  RECOMMENDATION_ID,
  "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7102",
  "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7103",
] as const;

async function setup() {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const context = persistTask18Context(db);
  return { context, db, service: new Recommendations(db) };
}

function replaceStoredProvenance(db: AuthorityDb, recommendationId: string, basis: string): void {
  const row = db.db.prepare(
    "SELECT canonical_envelope_json FROM personal_recommendations WHERE recommendation_id=?",
  ).get(recommendationId);
  if (typeof row !== "object" || row === null) throw new TypeError("stored recommendation required");
  const envelope: unknown = JSON.parse(String(Reflect.get(row, "canonical_envelope_json")));
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new TypeError("stored envelope required");
  }
  const payload = Reflect.get(envelope, "payload");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("stored payload required");
  }
  Reflect.set(payload, "confidence_basis", basis);
  db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
  db.db.prepare(
    "UPDATE personal_recommendations SET canonical_envelope_json=? WHERE recommendation_id=?",
  ).run(JSON.stringify(envelope), recommendationId);
}

function expectTypedFailure(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ name: "RecommendationError" }));
}

describe("Task 18 exception remediation", () => {
  it("rejects an unrelated persisted-evidence alias in every ordinary citation slot", async () => {
    const { context, db, service } = await setup();
    try {
      const request = task18Request(context);
      for (const slot of CITATION_SLOTS.filter(candidate => candidate !== "linux_policy_decision_ref")) {
        const source = request.ranking.actions.find(action => action.rationale.citations[slot] !== null)
          ?? request.ranking.actions[0];
        if (source === undefined) throw new TypeError(`citation fixture required: ${slot}`);
        const original = source.rationale.citations[slot];
        const alias = `alias:${slot}`;
        const ranking = { ...request.ranking, actions: request.ranking.actions.map(action => action.action_id === source.action_id
          ? { ...action, rationale: { ...action.rationale, citations: { ...action.rationale.citations, [slot]: alias } } }
          : action) };
        const originalLink = request.linux_evidence.find(link => link.ref === (original
          ?? source.rationale.citations.current_linux_evidence_ref));
        if (originalLink === undefined) throw new TypeError(`evidence fixture required: ${slot}`);
        const linuxEvidence = [...request.linux_evidence, { ...originalLink, ref: alias,
          kind: slot === "stable_identity_evidence_ref" ? "stable_identity" as const : originalLink.kind }];
        expect(() => service.create({ ...request, ranking, linux_evidence: linuxEvidence }))
          .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EVIDENCE_CONFLICT" }));
      }
    } finally { db.close(); }
  });

  it("accepts the exact policy citation and rejects an arbitrary policy relabel", async () => {
    const { context, db, service } = await setup();
    try {
      const request = task18Request(context);
      expect(service.create(request).recommendation.id).toBe(RECOMMENDATION_ID);
      const exact = task18Request(context, IDS[1]);
      const exactRanking = { ...exact.ranking, actions: exact.ranking.actions.map(action => action.rank === 1
        ? { ...action, rationale: { ...action.rationale, citations: { ...action.rationale.citations,
            deadline_evidence_ref: "live:deadline", dependency_evidence_ref: "live:dependency",
            stable_identity_evidence_ref: "identity:customer-delivery" } } }
        : action) };
      const exactLinks = exact.linux_evidence.flatMap(link => {
        if (link.ref !== "live:customer") return [link];
        if (link.context_evidence_id === null) throw new TypeError("current evidence fixture required");
        return [{ ...link, kind: "current" as const },
          { ref: "live:deadline", kind: "deadline" as const,
            context_evidence_id: task18EvidenceForReference(context, "live:deadline").evidence_id,
            digest: task18EvidenceForReference(context, "live:deadline").digest },
          { ref: "live:dependency", kind: "dependency" as const,
            context_evidence_id: task18EvidenceForReference(context, "live:dependency").evidence_id,
            digest: task18EvidenceForReference(context, "live:dependency").digest },
          { ref: "identity:customer-delivery", kind: "stable_identity" as const,
            context_evidence_id: task18EvidenceForReference(context, "identity:customer-delivery").evidence_id,
            digest: task18EvidenceForReference(context, "identity:customer-delivery").digest }];
      });
      expect(service.create({ ...exact, ranking: exactRanking, linux_evidence: exactLinks }).recommendation.id).toBe(IDS[1]);
      const original = request.ranking.linux_policy_decision_ref;
      if (original === null) throw new TypeError("policy citation fixture required");
      const arbitrary = "totally-arbitrary:not-policy";
      const alternate = task18Request(context, IDS[2]);
      const ranking = { ...alternate.ranking, linux_policy_decision_ref: arbitrary,
        actions: alternate.ranking.actions.map(action => ({ ...action, rationale: { ...action.rationale,
          citations: { ...action.rationale.citations, linux_policy_decision_ref: arbitrary } } })) };
      const linuxEvidence = alternate.linux_evidence.map(link => link.ref === original
        ? { ref: arbitrary, kind: "policy" as const, context_evidence_id: null, digest: alternate.context_digest }
        : link);
      expect(() => service.create({ ...alternate, ranking, linux_evidence: linuxEvidence }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EVIDENCE_CONFLICT" }));
    } finally { db.close(); }
  });

  it("uses recommendation freshness as the inclusive expiry boundary", async () => {
    const { context, db, service } = await setup();
    try {
      const created = service.create(task18Request(context));
      const deadline = created.recommendation.freshness.fresh_until;
      const before = new Date(Date.parse(deadline) - 1).toISOString();
      expect(() => service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "expired",
        evidence_digest: created.evidence_digest, occurred_at: before }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_TRANSITION_CONFLICT" }));
      service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 2, state: "expired",
        evidence_digest: created.evidence_digest, occurred_at: deadline });
      expect(() => service.transition({ recommendation_id: RECOMMENDATION_ID, rank: 3, state: "accepted",
        evidence_digest: created.evidence_digest, occurred_at: deadline }))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_EXPIRED" }));
      expect(service.project(deadline).next_actions).toHaveLength(0);
    } finally { db.close(); }
  });

  it("maps malformed, oversized encoded, oversized inflated, and invalid decoded provenance to typed failures", async () => {
    const cases = [
      "task18:v1:%%%",
      `task18:v1:${"A".repeat(40_000)}`,
      `task18:v1:${deflateRawSync(Buffer.from("x".repeat(300_000))).toString("base64url")}`,
      `task18:v1:${deflateRawSync(Buffer.from("{}")).toString("base64url")}`,
    ];
    for (const basis of cases) {
      const { context, db, service } = await setup();
      try {
        service.create(task18Request(context));
        replaceStoredProvenance(db, RECOMMENDATION_ID, basis);
        expectTypedFailure(() => service.project("2026-08-28T12:10:00.000Z"));
      } finally { db.close(); }
    }
  });

  it("bounds candidate provenance work by the positive projection limit", async () => {
    const { context, db, service } = await setup();
    try {
      for (const id of IDS) service.create(task18Request(context, id));
      replaceStoredProvenance(db, IDS[2], "task18:v1:malformed-outside-limit");
      const projection = service.project("2026-08-28T12:10:00.000Z", 1);
      expect(projection.lifecycle_actions).toHaveLength(1);
      expect(projection.lifecycle_actions[0]?.recommendation_id).toBe(IDS[0]);
    } finally { db.close(); }
  });
});
