import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation, prepareLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { Recommendations, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { assemblePersonalContext } from "../../src/context-assembler.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "../../src/personal-validation.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import { MorningRecommendationSource, MorningRecommendationSourceError } from "../../src/morning-recommendation-source.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { tempDb } from "../helpers.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const AT = "2026-08-28T12:00:00.000Z";
const PRINCIPLE_REF = "memory:principle:customer-first";
const OWNER_REF = "decision:owner:import";
const CONTEXT_ID = "ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7100";
const RECOMMENDATION_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7101";
const TASK_ID = "task:fixture";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function policyFact(ref: string, evidenceClass: string): Record<string, unknown> {
  return { kind: "evidence", ref, evidence_class: evidenceClass,
    source_host: evidenceClass === "user_confirmed_principle" ? "linux-second-brain" : "linux-control-plane",
    state: "current", trust: "user_confirmed", relation: "supports",
    relates_to: evidenceClass === "linux_live_fact" ? null : PRINCIPLE_REF,
    observed_at: "2026-08-28T11:30:00.000Z", valid_from: "2026-08-28T11:00:00.000Z",
    valid_until: "2026-08-28T18:00:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z" };
}
const confirmedMemory = {
  kind: "evidence" as const, memory_ref: PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
  digest: DIGEST_A, observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
  excerpt: "Prioritize confirmed customer obligations before internal improvements.",
  trust: "user_confirmed" as const, sensitivity: "personal" as const,
  relevance: "related" as const, relation: "supports" as const,
};

/** Admits one current local observation and returns its envelope plus the collection store. */
async function admitObservation() {
  const clock = () => new Date(AT);
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await db.migrate();
  db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
    VALUES ('fixture','${TASK_ID}','dispatch','{}','sha256:fixture','fixture','pending','2026-08-28T11:00:00.000Z')`);
  const store = new LocalTimelineSnapshotStore(db, clock);
  store.register(TASK_ID);
  const snapshot = store.refresh(TASK_ID);
  const admitted = admitLocalTimelineObservation(db, TASK_ID, snapshot.collection_id, clock);
  const observation = prepareLocalTimelineObservation(db, TASK_ID, snapshot.collection_id, clock);
  return { db, store, admitted, observation };
}

/** Cited context: the admitted local observation plus confirmed memory and the owner import decision. */
function persistCitedContext(db: AuthorityDb, observationId: string, observationDigest: string, observedAt: string) {
  const memories = [
    { memory_ref: PRINCIPLE_REF, kind: "user_confirmed_principle", digest: DIGEST_A },
    { memory_ref: OWNER_REF, kind: "owner_decision", digest: DIGEST_B },
  ] as const;
  const evidence = [
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7201", digest: observationDigest,
      kind: "linux_live_fact", source_id: "src:pos:v1:task-timeline:local", observed_at: observedAt },
    ...memories.map((item, index) => ({ evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f730${index + 1}`,
      digest: item.digest, kind: item.kind, source_id: "src:pos:v1:second-brain:primary",
      observed_at: "2026-08-28T11:30:00.000Z" })),
  ];
  const context = parseContextSnapshotV1({
    schema_version: 1, id: CONTEXT_ID, created_at: AT, observed_at: AT, valid_at: AT,
    source: { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority",
      host_id: "host:pos:linux-control-plane", source_version: "local-lineage-v1",
      evidence_ref: "context:local-lineage" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: AT, fresh_until: "2026-08-28T12:03:59.999Z" },
    expires_at: "2026-08-28T12:04:00.000Z", idempotency_key: `idem:pos:v1:context:${"1".repeat(64)}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    payload: { purpose: "daily_prioritization", query: "What should happen next?",
      included_observation_refs: [observationId], included_memory_refs: memories.map(item => item.memory_ref),
      excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [],
      budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence, receipt: null,
  });
  const stored = db.persistContextSnapshot({ context, memory_evidence: memories.map((item, index) => ({
    memory_ref: item.memory_ref, evidence_id: evidence[index + 1]?.evidence_id ?? "",
    source_id: "src:pos:v1:second-brain:primary", digest: item.digest,
    observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z" })) }, AT);
  return { context, stored, evidence };
}

function createRecommendation(db: AuthorityDb, observationId: string, observationDigest: string,
  context: ReturnType<typeof parseContextSnapshotV1>, evidence: readonly { evidence_id: string }[]) {
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), {
    schema_version: 1, clock: AT, linux_policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    context_policy_input: { schema_version: 1, clock: AT,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: [policyFact(observationId, "linux_live_fact"), policyFact(PRINCIPLE_REF, "user_confirmed_principle"),
        policyFact(OWNER_REF, "owner_decision")] },
    principles: [{ kind: "evidence", principle_ref: PRINCIPLE_REF, evidence_ref: PRINCIPLE_REF,
      source_id: "src:pos:v1:second-brain:primary", source_host: "linux-second-brain", content_digest: DIGEST_A,
      trust: "user_confirmed", observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
      import_gate: { gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL", state: "approved",
        decision_ref: OWNER_REF, decision_host: "linux-control-plane" } }],
    candidates: [{ action_id: "local-task-followup", execution_mode: "jarvis", owner_safety_gate: "pass",
      owner_gate_ref: null, customer_impact: "customer_critical", deadline: null,
      dependency: { kind: "non_blocking" }, irreversible_risk: "low", effort_cost: "medium",
      principle_ref: PRINCIPLE_REF, current_evidence_ref: observationId,
      stable_identity: { key: "local-task-followup", evidence_ref: observationId } }],
    presentation: { model_disagrees: false, model_preferred_action_ids: [], mac_evidence_refs: [] },
  });
  const contextDigest = canonicalPersonalContractHash(context);
  return new Recommendations(db).create({
    id: RECOMMENDATION_ID, idempotency_key: `idem:pos:v1:recommendation:${"c".repeat(64)}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    context_id: CONTEXT_ID, context_digest: contextDigest, expires_at: "2026-08-28T12:03:00.000Z", ranking,
    actions: [{ action_id: "local-task-followup", title: "Next: local-task-followup", operation: "review",
      target_digest: DIGEST_A }],
    linux_evidence: [
      { ref: PRINCIPLE_REF, kind: "principle", context_evidence_id: evidence[1]?.evidence_id ?? "", digest: DIGEST_A },
      { ref: "policy:linux:personal-os-policy-v1:task17", kind: "policy", context_evidence_id: null,
        digest: contextDigest },
      { ref: OWNER_REF, kind: "owner", context_evidence_id: evidence[2]?.evidence_id ?? "", digest: DIGEST_B },
      { ref: observationId, kind: "stable_identity", context_evidence_id: evidence[0]?.evidence_id ?? "",
        digest: observationDigest },
    ],
    approval_requirement: "none", confidence_class: "high",
  });
}

async function chain() {
  const { db, store, admitted, observation } = await admitObservation();
  const { context, stored, evidence } = persistCitedContext(db, observation.id, admitted.canonical_digest,
    observation.observed_at);
  const created = createRecommendation(db, observation.id, admitted.canonical_digest, context, evidence);
  return { db, store, admitted, observation, context, stored, created };
}

const nextActionIds = (db: AuthorityDb) => projectRecommendations(db.db, AT).next_actions
  .map(item => `${item.recommendation_id}#${item.rank}`);
const todayActionIds = (db: AuthorityDb) => ((todayProjection(db, new Date(AT)) as
  Record<string, unknown>)["next_actions"] as { recommendation_id: string; rank: number }[])
  .map(item => `${item.recommendation_id}#${item.rank}`);
const writes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

it("binds source, collection, observation, context and recommendation identities in one chain", async () => {
  const { db, admitted, observation, context, stored, created } = await chain();
  expect(observation.source.source_id).toBe("src:pos:v1:task-timeline:local");
  expect(observation.source.evidence_ref).toBe(db.db.prepare(
    "SELECT collection_id FROM local_timeline_subjects WHERE task_id=?").pluck().get(TASK_ID));
  expect(stored.observation_count).toBe(1);
  expect(context.evidence[0]?.digest).toBe(admitted.canonical_digest);
  expect(created.recommendation.payload.context_id).toBe(CONTEXT_ID);
  expect(created.recommendation.payload.context_digest).toBe(canonicalPersonalContractHash(context));
  expect(created.recommendation.evidence).toEqual(context.evidence);
  expect(created.recommendation.expires_at <= context.expires_at).toBe(true);
  expect(created.recommendation.freshness.fresh_until <= context.freshness.fresh_until).toBe(true);
  const brief = new MorningRecommendationSource(db).generate(AT);
  expect(brief.source.lineage).toEqual([{ context_id: CONTEXT_ID, recommendation_id: RECOMMENDATION_ID,
    rank: 1, action_id: "local-task-followup", identity_digest: created.identity_digest }]);
  expect(brief.source.input.items).toHaveLength(1);
  expect(nextActionIds(db)).toEqual([`${RECOMMENDATION_ID}#1`]);
  expect(todayActionIds(db)).toEqual([`${RECOMMENDATION_ID}#1`]);
});

it("stops exposing current actions once the local source is held, without writing", async () => {
  const { db, store } = await chain();
  store.setHeld(TASK_ID, true);
  const before = writes(db);
  expect(() => new MorningRecommendationSource(db).generate(AT)).toThrow(MorningRecommendationSourceError);
  expect(nextActionIds(db)).toEqual([]);
  expect(todayActionIds(db)).toEqual([]);
  expect(projectRecommendations(db.db, AT).lifecycle_actions).toHaveLength(1);
  expect(projectRecommendations(db.db, AT).warnings).toEqual([
    { recommendation_id: RECOMMENDATION_ID, code: "RECOMMENDATION_SOURCE_UNAVAILABLE",
      deadline: "2026-08-28T12:02:59.999Z" }]);
  expect(writes(db)).toEqual(before);
});

it("stops exposing current actions after the collection is replaced or the observation is quarantined", async () => {
  const replaced = await chain();
  replaced.store.refresh(TASK_ID);
  expect(nextActionIds(replaced.db)).toEqual([]);
  expect(todayActionIds(replaced.db)).toEqual([]);

  const quarantined = await chain();
  new MemoryProjectionAuthority(quarantined.db).quarantineUnresolved({ kind: "observation",
    id: quarantined.observation.id, component_id: quarantined.observation.id }, new Date(AT));
  expect(nextActionIds(quarantined.db)).toEqual([]);
  expect(todayActionIds(quarantined.db)).toEqual([]);
});

it("keeps assembled contexts out of recommendations while their evidence kinds stay uncitable", async () => {
  const { db, observation } = await admitObservation();
  const context = assemblePersonalContext({ purpose: "daily_prioritization", query: "what now?", clock: AT,
    expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 4096 },
    observations: [observation], pending_authority_refs: [], memories: [confirmedMemory] });
  expect(context.payload.state).toBe("sufficient");
  expect(context.payload.included_observation_refs).toEqual([observation.id]);
  expect(context.evidence.map(item => item.kind)).toEqual(["context_observation", "confirmed_memory"]);
  const memoryEvidence = context.evidence[1];
  expect(memoryEvidence).toBeDefined();
  db.persistContextSnapshot({ context, memory_evidence: [{ memory_ref: PRINCIPLE_REF,
    evidence_id: memoryEvidence?.evidence_id ?? "", source_id: confirmedMemory.source_id,
    digest: confirmedMemory.digest, observed_at: confirmedMemory.observed_at,
    fresh_until: confirmedMemory.fresh_until }] }, AT);
  // Citation binding requires linux_live_fact / user_confirmed_principle / owner_decision evidence kinds.
  expect(db.db.prepare("SELECT evidence_kind FROM personal_context_evidence WHERE context_id=? ORDER BY position")
    .pluck().all(context.id)).toEqual(["context_observation", "confirmed_memory"]);
});
