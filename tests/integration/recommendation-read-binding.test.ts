import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import type { RecommendationId } from "../../src/personal-contracts.js";
import { Recommendations } from "../../src/recommendations.js";
import { TaskTimeline } from "../../src/recommendation-timeline.js";
import { canonicalPersonalContractHash, parseRecommendationV1 } from "../../src/personal-validation.js";
import { persistenceHash } from "../../src/personal-persistence-values.js";
import { tempDb } from "../helpers.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

let db: AuthorityDb;
let recommendationId: RecommendationId;
beforeAll(async () => {
  db = new AuthorityDb(tempDb()); await db.migrate();
  const request = task18Request(persistTask18Context(db));
  recommendationId = new Recommendations(db).create({ ...request, actions: [...request.actions].reverse() }).recommendation.id;
});
beforeEach(() => db.db.exec("BEGIN"));
afterEach(() => db.db.exec("ROLLBACK"));
afterAll(() => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); });
const reads = () => ({
  projection: () => new Recommendations(db).project(RECOMMENDATION_NOW),
  personal: () => db.getPersonalRecommendation(recommendationId),
  list: () => new TaskTimeline(db).list(),
  timeline: () => new TaskTimeline(db).timeline(RECOMMENDATION_ID),
  context: () => new TaskTimeline(db).context(RECOMMENDATION_ID, 100, 128 * 1024, new Date(RECOMMENDATION_NOW)),
});
const snapshot = () => Object.fromEntries(Object.entries(reads()).map(([name, read]) => [name, read()]));
const changes = () => db.db.prepare("SELECT total_changes() AS n").get();
function rewriteEnvelope(change: (input: Record<string, any>) => void, rehash = false, pretty = false): void {
  const row = db.db.prepare("SELECT canonical_envelope_json FROM personal_recommendations").get() as { canonical_envelope_json: string };
  const raw = JSON.parse(row.canonical_envelope_json); change(raw);
  db.db.exec("DROP TRIGGER personal_recommendations_immutable_update");
  db.db.prepare("UPDATE personal_recommendations SET canonical_envelope_json=?").run(JSON.stringify(raw, null, pretty ? 2 : undefined));
  if (rehash) {
    const parsed = parseRecommendationV1(raw); const digest = canonicalPersonalContractHash(parsed);
    db.db.prepare("UPDATE personal_recommendations SET canonical_digest=?,persistence_digest=?")
      .run(digest, persistenceHash({ canonical_digest: digest, approval_requirement: "owner", confidence_class: "high" }));
  }
}
const cases = [
  ["canonical digest", "personal_recommendations", "canonical_digest", `sha256:${"a".repeat(64)}`],
  ["evidence digest", "personal_recommendations", "evidence_digest", `sha256:${"b".repeat(64)}`],
  ["approval", "personal_recommendations", "approval_requirement", "none"],
  ["confidence", "personal_recommendations", "confidence_class", "low"],
  ["expiry", "personal_recommendations", "expires_at", "2026-08-28T13:01:00.000Z"],
  ["context digest", "personal_recommendations", "context_digest", `sha256:${"c".repeat(64)}`],
  ["title", "personal_recommendation_actions", "title", "Unrelated secret marker"],
  ["operation", "personal_recommendation_actions", "operation", "unrelated-review"],
  ["target", "personal_recommendation_actions", "target_digest", `sha256:${"d".repeat(64)}`],
] as const;
it.each(cases)("rejects stored %s divergence across recommendation reads", (_name, table, field, value) => {
  db.db.exec(`DROP TRIGGER ${table}_immutable_update`);
  db.db.prepare(`UPDATE ${table} SET ${field}=?`).run(value);
  const before = changes();
  for (const read of Object.values(reads())) expect(read).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
  expect(changes()).toEqual(before);
});
it("rejects a self-consistent envelope belonging to another recommendation before event lookup", () => {
  rewriteEnvelope(raw => { raw.id = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7999"; }, true);
  for (const read of Object.values(reads())) expect(read).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
});
it.each([false, true])("rejects changed canonical copy while its action row remains intact (rehash=%s)", rehash => {
  rewriteEnvelope(raw => { raw.payload.actions[0].title = "Unrelated secret marker"; }, rehash);
  for (const read of Object.values(reads())) expect(read).toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
});
it("does not bypass task18 validation with pretty JSON", () => {
  rewriteEnvelope(raw => { raw.payload.confidence_basis = "task18:v1:invalid"; }, true, true);
  expect(() => db.getPersonalRecommendation(recommendationId))
    .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_INPUT_INVALID" }));
});
it("preserves reverse-submitted action material and whitespace-only canonical representations", () => {
  const before = snapshot();
  rewriteEnvelope(() => {}, false, true);
  const beforeReads = changes(); expect(snapshot()).toEqual(before); expect(changes()).toEqual(beforeReads);
  expect(new Recommendations(db).project(RECOMMENDATION_NOW).next_actions).toHaveLength(3);
});
it("keeps legacy RecommendationV1 readable without task18 compressed provenance", () => {
  rewriteEnvelope(raw => { raw.source.source_version = "legacy-v1"; raw.payload.confidence_basis = "legacy evidence description"; }, true);
  const value = db.getPersonalRecommendation(recommendationId);
  expect(value?.actions).toHaveLength(3);
});
it("keeps accepted and time-expired recommendations readable", () => {
  const row = db.db.prepare("SELECT evidence_digest FROM personal_recommendations").get() as { evidence_digest: string };
  new Recommendations(db).transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "accepted",
    evidence_digest: row.evidence_digest, occurred_at: "2026-08-28T12:01:00.000Z" });
  expect(snapshot()).toBeDefined();
  expect(new Recommendations(db).project("2026-08-28T14:00:00.000Z").next_actions).toEqual([]);
  expect(new Recommendations(db).project("2026-08-28T14:00:00.000Z").lifecycle_actions).toHaveLength(3);
});
