import { describe, expect, it } from "vitest";
import {
  Recommendations,
  RecommendationWorkflowStager,
  type AuthorityDb,
} from "../../src/index.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:00.000Z");
const D1 = `sha256:${"d".repeat(64)}`;
const D2 = `sha256:${"e".repeat(64)}`;
function request(): unknown {
  return {
    schema_version: 1, recommendation_id: RECOMMENDATION_ID, action_rank: 1,
    requested_by: { principal_id: "test-operator", authenticated_session_id: "session:owner" },
    target: { repository: "Orca-JARVIS", environment: "local" },
    workflow: { goal: "Implement the bounded recommended action", args: { branch: "task25" } },
    budget: { max_steps: 6, max_attempts_per_node: 2 },
    deadline: "2026-08-28T12:45:00.000Z",
  };
}
function seed(db: AuthorityDb): void {
  const context = persistTask18Context(db);
  new Recommendations(db).create(task18Request(context));
}
function sql(statement: string, ...values: readonly unknown[]): (db: AuthorityDb) => void {
  return db => { db.db.prepare(statement).run(...values); };
}
type Mutation = {
  readonly name: string;
  readonly trigger: string;
  readonly mutate: (db: AuthorityDb) => void;
  readonly foreignKeys?: false;
};
const recommendation = (name: string, assignment: string, value: unknown): Mutation => ({
  name: `recommendation.${name}`, trigger: "personal_recommendations_immutable_update",
  mutate: sql(`UPDATE personal_recommendations SET ${assignment} WHERE recommendation_id=?`, value, RECOMMENDATION_ID),
});
const context = (name: string, assignment: string, value: unknown): Mutation => ({
  name: `context.${name}`, trigger: "personal_context_snapshots_immutable_update",
  mutate: sql(`UPDATE personal_context_snapshots SET ${assignment}`, value),
});
const action = (name: string, assignment: string, value: unknown): Mutation => ({
  name: `action.${name}`, trigger: "personal_recommendation_actions_immutable_update",
  mutate: sql(`UPDATE personal_recommendation_actions SET ${assignment} WHERE recommendation_id=? AND rank=1`, value, RECOMMENDATION_ID),
});
const event = (name: string, assignment: string, value: unknown): Mutation => ({
  name: `event.${name}`, trigger: "personal_recommendation_action_events_immutable_update",
  mutate: sql(`UPDATE personal_recommendation_action_events SET ${assignment} WHERE recommendation_id=? AND rank=1`, value, RECOMMENDATION_ID),
});
const MUTATIONS: readonly Mutation[] = [
  { ...recommendation("recommendation_id", "recommendation_id=?", "rec:missing"), foreignKeys: false },
  recommendation("idempotency", "idempotency_key=?", `idem:pos:v1:recommendation:${"9".repeat(64)}`),
  { ...recommendation("context_id", "context_id=?", "ctx:missing"), foreignKeys: false },
  recommendation("context_digest", "context_digest=?", D1),
  recommendation("canonical_digest", "canonical_digest=?", D1),
  recommendation("evidence_digest", "evidence_digest=?", D1),
  recommendation("persistence_digest", "persistence_digest=?", D1),
  recommendation("approval", "approval_requirement=?", "none"),
  recommendation("confidence", "confidence_class=?", "low"),
  recommendation("lifecycle", "lifecycle_state=?", "presented"),
  recommendation("observed_at", "observed_at=?", "2026-08-28T11:58:59.999Z"),
  recommendation("valid_at", "valid_at=?", "2026-08-28T11:58:59.999Z"),
  recommendation("expires_at", "expires_at=?", "2026-08-28T12:50:00.000Z"),
  recommendation("created_at", "created_at=?", "2026-08-28T12:00:00.001Z"),
  {
    name: "recommendation.envelope", trigger: "personal_recommendations_immutable_update",
    mutate: sql(`UPDATE personal_recommendations
      SET canonical_envelope_json=replace(canonical_envelope_json,'"state":"eligible"','"state":"presented"')
      WHERE recommendation_id=?`, RECOMMENDATION_ID),
  },
  context("idempotency", "idempotency_key=?", `idem:pos:v1:context:${"9".repeat(64)}`),
  context("purpose", "purpose=?", "changed-purpose"),
  context("query", "declared_query=?", "changed query"),
  context("version", "version=?", 2),
  context("canonical_digest", "canonical_digest=?", D2),
  context("persistence_digest", "persistence_digest=?", D2),
  {
    name: "context.envelope", trigger: "personal_context_snapshots_immutable_update",
    mutate: sql(`UPDATE personal_context_snapshots
      SET canonical_envelope_json=replace(canonical_envelope_json,'"state":"sufficient"','"state":"insufficient"')`),
  },
  context("payload_state", "payload_state=?", "insufficient"),
  context("freshness_state", "freshness_state=?", "stale"),
  context("fresh_until", "fresh_until=?", "2026-08-28T12:50:00.000Z"),
  {
    name: "context.item_count", trigger: "personal_context_snapshots_immutable_update",
    mutate: sql("UPDATE personal_context_snapshots SET item_count=item_count-1"),
  },
  context("observation_count", "observation_count=?", 1),
  context("evidence_count", "evidence_count=?", 11),
  context("memory_count", "memory_count=?", 11),
  context("max_items", "max_items=?", 17),
  context("max_excerpt_bytes", "max_excerpt_bytes=?", 1025),
  context("max_total_bytes", "max_total_bytes=?", 8193),
  context("conflict_count", "conflict_count=?", 0),
  context("omission_count", "omission_count=?", 0),
  context("expires_at", "expires_at=?", "2026-08-28T12:50:00.000Z"),
  context("observed_at", "observed_at=?", "2026-08-28T11:58:59.999Z"),
  context("valid_at", "valid_at=?", "2026-08-28T11:58:59.999Z"),
  context("created_at", "created_at=?", "2026-08-28T12:00:00.001Z"),
  { ...action("rank", "rank=?", 20), foreignKeys: false },
  action("title", "title=?", "Changed title"),
  action("operation", "operation=?", "changed"),
  action("target_digest", "target_digest=?", D1),
  { ...event("recommendation_id", "recommendation_id=?", "rec:missing"), foreignKeys: false },
  { ...event("rank", "rank=?", 20), foreignKeys: false },
  event("event_sequence", "event_sequence=?", 999),
  event("state", "state=?", "accepted"),
  event("evidence_digest", "evidence_digest=?", D1),
  event("occurred_at", "occurred_at=?", "2026-08-28T12:00:00.001Z"),
  event("transition_occurred_at", "transition_occurred_at=?", "2026-08-28T12:00:00.000Z"),
  event("transition_digest", "transition_digest=?", D1),
  event("replacement", "replacement_recommendation_id=?", RECOMMENDATION_ID),
  {
    name: "context_evidence.position", trigger: "personal_context_evidence_immutable_update",
    mutate: sql("UPDATE personal_context_evidence SET position=20 WHERE position=0"),
  },
  {
    name: "recommendation_evidence.position", trigger: "personal_recommendation_evidence_immutable_update",
    mutate: sql("UPDATE personal_recommendation_evidence SET position=20 WHERE position=0"),
  },
] as const;

describe("Task 25 persisted authority mutation matrix", () => {
  it.each(MUTATIONS)("rejects one-field mutation: $name", async mutation => {
    // Given: one authoritative field changed after its immutable trigger is removed.
    const db = await initialized();
    try {
      seed(db); db.db.exec(`DROP TRIGGER ${mutation.trigger}`);
      if (mutation.foreignKeys === false) db.db.pragma("foreign_keys=OFF");
      mutation.mutate(db);
      if (mutation.foreignKeys === false) db.db.pragma("foreign_keys=ON");

      // When/Then: canonical reload fails generically before any request write.
      expect(() => new RecommendationWorkflowStager(db, () => NOW).stage(request()))
        .toThrowError(expect.objectContaining({ code: "RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE" }));
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
});
