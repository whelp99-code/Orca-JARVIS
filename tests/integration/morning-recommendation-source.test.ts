import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { MorningRecommendationSource, MorningRecommendationSourceError } from "../../src/morning-recommendation-source.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { defaultPriorityCandidates } from "../fixtures/priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { persistTask18Context, RECOMMENDATION_NOW, RECOMMENDATION_ID, REPLACEMENT_ID, task18Request,
  task18Substitute } from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
async function setup(legacy = false, candidatesOverride?: Record<string, unknown>[]) {
  const path = tempDb(); const db = new AuthorityDb(path); opened.push(db); await db.migrate();
  const context = await persistTask18Context(db); const request = task18Request(context);
  const wanted = new Set(request.ranking.actions.map(action => action.action_id));
  const candidates = candidatesOverride ?? defaultPriorityCandidates().filter(item => wanted.has(String(item["action_id"])));
  // The priority fixtures speak in readable slot names; only the substituted references are ones
  // the database can back, so the same mapping the context used has to reach this ranking.
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(),
    task18Substitute(context, priorityEngineInput({ candidates })));
  const created = new Recommendations(db).create({ ...request, ranking: legacy ? request.ranking : ranking });
  return { db, path, context, created, ranking, candidates };
}
function dropGuards(db: AuthorityDb, table: string) {
  const triggers = db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[];
  for (const { name } of triggers) db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
}
const writes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

describe("stored recommendations as morning sources", () => {
  it("generates from persisted facts after SQLite reopen, without fixture defaults or writes", async () => {
    const first = await setup(); first.db.close(); opened.pop();
    const db = new AuthorityDb(first.path); opened.push(db); const before = writes(db);
    const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
    expect(result.source.input.items).toHaveLength(3);
    const item = result.source.input.items.find(item => item.copy === "Next: customer-delivery")!;
    const decision = first.ranking.actions.find(item => item.action_id === "customer-delivery")!;
    const deadline = first.ranking.deadline_evidence.find(item => item.action_id === "customer-delivery")!;
    expect(item.priority).toEqual(decision.rationale.lexicographic_fields);
    expect(item.deadline).toBe(deadline.deadline?.due_at);
    expect(item.trust).toBe("inferred");
    expect(item.valid_from).toBe(first.created.recommendation.valid_at);
    expect(item.citations.some(link => link.evidence_ref === deadline.deadline?.evidence_ref)).toBe(true);
    expect(result.source.lineage).toHaveLength(3);
    expect(result.source.lineage.every(link => link.identity_digest === first.created.identity_digest)).toBe(true);
    expect(result.brief.schema_version).toBe(2);
    expect(result.brief.needs_you_first).toHaveLength(1);
    expect(result.source.input.context_readiness).toBe("degraded");
    expect(writes(db)).toEqual(before);
    expect(new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW)).toEqual(result);
  });

  it("keeps legacy ranking gaps explicit instead of fabricating deadlines", async () => {
    const { db } = await setup(true);
    const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
    expect(result.source.excluded.legacy_ranking).toBe(3);
    expect(result.source.input.items).toEqual([]);
    expect(result.source.input.context_readiness).toBe("degraded");
    expect(result.brief.abstention_reasons).toEqual(["no_authoritative_data"]);
  });

  it("namespaces repeated action IDs and retains every contributor when recommendations merge", async () => {
    const { db, context, ranking } = await setup(); const service = new Recommendations(db);
    service.create({ ...task18Request(context, REPLACEMENT_ID), ranking });
    const reader = new MorningRecommendationSource(db);
    const merged = reader.generate(RECOMMENDATION_NOW);
    expect(merged.source.input.items).toHaveLength(6);
    expect(new Set(merged.source.input.items.map(item => item.action_id)).size).toBe(6);
    expect(merged.brief.needs_you_first).toHaveLength(1);
    expect(merged.brief.needs_you_first[0]?.contributing_recommendation_ids).toEqual([RECOMMENDATION_ID, REPLACEMENT_ID]);
    expect(merged.source.lineage).toHaveLength(6);
    const request = task18Request(context, "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7103");
    service.create({ ...request, ranking, actions: request.actions.map(item => ({ ...item, operation: "inspect" })) });
    expect(reader.generate(RECOMMENDATION_NOW).brief.needs_you_first).toHaveLength(2);
  });

  it("recalculates overdue from exact due_at at the report clock", async () => {
    const wanted = new Set(["customer-delivery", "worker-implementation", "owner-gated-deploy"]);
    const candidates = defaultPriorityCandidates().filter(item => wanted.has(String(item["action_id"]))).map(item =>
      item["action_id"] === "customer-delivery" ? { ...item,
        deadline: { ...(item["deadline"] as object), due_at: "2026-08-28T12:01:00.000Z" } } : item);
    const { db } = await setup(false, candidates);
    // A context resting on live Linux facts expires with them, so the report clock stays inside
    // the window those observations are fresh for.
    const result = new MorningRecommendationSource(db).generate("2026-08-28T12:02:00.000Z");
    expect(result.brief.needs_you_first.find(item => item.copy === "Next: customer-delivery")?.priority.deadline_bucket).toBe("overdue");
  });

  it("omits stale deadline evidence even while the recommendation remains fresh", async () => {
    const wanted = new Set(["customer-delivery", "worker-implementation", "owner-gated-deploy"]);
    const candidates = defaultPriorityCandidates().filter(item => wanted.has(String(item["action_id"]))).map(item =>
      item["action_id"] === "customer-delivery" ? { ...item,
        deadline: { ...(item["deadline"] as object), fresh_until: "2026-08-28T12:01:00.000Z" } } : item);
    const { db } = await setup(false, candidates);
    const result = new MorningRecommendationSource(db).generate("2026-08-28T12:02:00.000Z");
    expect(result.source.excluded.stale_deadline).toBe(1);
    expect(JSON.stringify(result.brief)).not.toContain("Next: customer-delivery");
  });

  it("removes accepted owner decisions without promoting them to confirmed facts", async () => {
    const { db, created, ranking } = await setup();
    const owner = ranking.actions.find(item => item.disposition === "owner_gate_required")!;
    new Recommendations(db).transition({ recommendation_id: RECOMMENDATION_ID, rank: owner.rank,
      state: "accepted", evidence_digest: created.evidence_digest, occurred_at: "2026-08-28T12:01:00.000Z" });
    const result = new MorningRecommendationSource(db).generate("2026-08-28T12:02:00.000Z");
    const source = result.source.input.items.find(item => item.copy === "Next: owner-gated-deploy");
    expect(source?.owner_decision_required).toBe(false); expect(source?.trust).toBe("inferred");
    expect(result.brief.needs_you_first).toHaveLength(0);
  });

  it("excludes rejected actions and marks capped reads as incomplete", async () => {
    const { db, created } = await setup();
    new Recommendations(db).transition({ recommendation_id: RECOMMENDATION_ID, rank: 1, state: "rejected",
      evidence_digest: created.evidence_digest, occurred_at: "2026-08-28T12:01:00.000Z" });
    const result = new MorningRecommendationSource(db).generate("2026-08-28T12:02:00.000Z", 2);
    expect(result.source.excluded.inactive).toBe(1);
    expect(result.source.source_capped).toBe(true);
    expect(result.source.input.items).toHaveLength(1);
  });

  it("does not apply a future recorded decision at an earlier report clock", async () => {
    const { db, created, ranking } = await setup();
    const owner = ranking.actions.find(item => item.disposition === "owner_gate_required")!;
    new Recommendations(db).transition({ recommendation_id: RECOMMENDATION_ID, rank: owner.rank,
      state: "accepted", evidence_digest: created.evidence_digest, occurred_at: "2026-08-28T12:02:00.000Z" });
    const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
    expect(result.source.excluded.inactive).toBe(1);
    expect(result.source.lineage.some(item => item.rank === owner.rank)).toBe(false);
  });

  it.each(["drafted", "parsed", "abstained", "rejected", "expired", "eligible", "presented", "selected"])(
    "respects the persisted recommendation lifecycle %s independently of pending actions", async state => {
      const { db, context, created } = await setup();
      const replacement = task18Request(context, REPLACEMENT_ID);
      db.persistRecommendation({ recommendation: { ...created.recommendation, id: REPLACEMENT_ID,
        idempotency_key: replacement.idempotency_key, payload: { ...created.recommendation.payload, state } },
      approval_requirement: "owner", confidence_class: "high" }, RECOMMENDATION_NOW);
      const before = writes(db); const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
      const active = ["eligible", "presented", "selected"].includes(state);
      expect(result.source.input.items).toHaveLength(active ? 6 : 3);
      expect(result.source.excluded.inactive).toBe(active ? 0 : 3);
      expect(result.source.lineage.filter(item => item.recommendation_id === REPLACEMENT_ID)).toHaveLength(active ? 3 : 0);
      expect(writes(db)).toEqual(before);
    },
  );

  it.each(["context", "recommendation"] as const)("filters quarantined %s before parsing its corrupted body", async kind => {
    const { db, context } = await setup();
    const id = kind === "context" ? context.id : RECOMMENDATION_ID;
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind, id, component_id: id }, new Date(RECOMMENDATION_NOW));
    const table = kind === "context" ? "personal_context_snapshots" : "personal_recommendations";
    dropGuards(db, table);
    db.db.prepare(`UPDATE ${table} SET canonical_envelope_json='not JSON'`).run();
    const before = writes(db); const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
    expect(result.source.input.context_readiness).toBe("no_data"); expect(result.source.lineage).toEqual([]);
    expect(writes(db)).toEqual(before);
  });

  it("filters a quarantined action before reading corrupted action and event rows", async () => {
    const { db } = await setup();
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "recommendation_action", id: RECOMMENDATION_ID,
      component_id: "1" }, new Date(RECOMMENDATION_NOW));
    dropGuards(db, "personal_recommendation_actions"); dropGuards(db, "personal_recommendation_action_events");
    db.db.prepare("UPDATE personal_recommendation_actions SET title='PRIVATE_BAD_SOURCE' WHERE rank=1").run();
    db.db.prepare("UPDATE personal_recommendation_action_events SET evidence_digest=? WHERE rank=1").run(`sha256:${"a".repeat(64)}`);
    const before = writes(db);
    const result = new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW);
    expect(result.source.lineage.map(item => item.rank)).toEqual([2, 3]);
    expect(JSON.stringify(result)).not.toContain("Next: customer-delivery");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BAD_SOURCE"); expect(writes(db)).toEqual(before);
    db.db.prepare("UPDATE personal_recommendation_actions SET title='ALTERED_VISIBLE_SOURCE' WHERE rank=2").run();
    expect(() => new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW)).toThrow(MorningRecommendationSourceError);
  });

  it("rejects altered context envelopes without returning their text", async () => {
    const { db } = await setup(); dropGuards(db, "personal_context_snapshots");
    db.db.prepare("UPDATE personal_context_snapshots SET canonical_envelope_json='PRIVATE_BAD_SOURCE'").run();
    expect(() => new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW)).toThrow(MorningRecommendationSourceError);
    expect(() => new MorningRecommendationSource(db).generate(RECOMMENDATION_NOW)).toThrow("MORNING_RECOMMENDATION_SOURCE_INVALID");
  });

  it("does not publish future or expired recommendations", async () => {
    const { db } = await setup(); const reader = new MorningRecommendationSource(db);
    for (const now of ["2026-08-28T11:59:59.999Z", "2026-08-28T13:00:00.000Z"]) {
      const result = reader.generate(now); expect(result.source.input.items).toEqual([]);
      expect(result.source.excluded.inactive).toBe(3);
    }
  });

  it("returns no_data for empty stores and validates clock and read bounds", async () => {
    const db = new AuthorityDb(tempDb()); opened.push(db); await db.migrate(); const reader = new MorningRecommendationSource(db);
    expect(reader.generate(RECOMMENDATION_NOW).brief.abstention_reasons).toEqual(["no_data"]);
    for (const max of [0, 257, 1.5, "1"]) expect(() => reader.read(RECOMMENDATION_NOW, max)).toThrow(MorningRecommendationSourceError);
    expect(() => reader.read("2026-02-30T00:00:00.000Z")).toThrow(MorningRecommendationSourceError);
  });
});
