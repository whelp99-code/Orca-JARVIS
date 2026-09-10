import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { assemblePersonalContext } from "../../src/context-assembler.js";
import { canonicalPersonalContractHash } from "../../src/personal-validation.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import { MorningRecommendationSource, MorningRecommendationSourceError } from "../../src/morning-recommendation-source.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import {
  admitLocalChainObservation,
  localChainConfirmedMemory,
  localObservationChain,
  LOCAL_CHAIN_AT,
  LOCAL_CHAIN_CONTEXT_ID,
  LOCAL_CHAIN_PRINCIPLE_REF,
  LOCAL_CHAIN_RECOMMENDATION_ID,
  LOCAL_CHAIN_TASK_ID,
} from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function open(): AuthorityDb {
  const db = new AuthorityDb(tempDb()); opened.push(db); return db;
}
async function chain() {
  const db = open();
  return { db, ...await localObservationChain(db) };
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
    "SELECT collection_id FROM local_timeline_subjects WHERE task_id=?").pluck().get(LOCAL_CHAIN_TASK_ID));
  expect(stored.observation_count).toBe(1);
  expect(context.evidence[0]?.digest).toBe(admitted.canonical_digest);
  expect(created.recommendation.payload.context_id).toBe(LOCAL_CHAIN_CONTEXT_ID);
  expect(created.recommendation.payload.context_digest).toBe(canonicalPersonalContractHash(context));
  expect(created.recommendation.evidence).toEqual(context.evidence);
  expect(created.recommendation.expires_at <= context.expires_at).toBe(true);
  expect(created.recommendation.freshness.fresh_until <= context.freshness.fresh_until).toBe(true);
  const brief = new MorningRecommendationSource(db).generate(AT);
  expect(brief.source.lineage).toEqual([{ context_id: LOCAL_CHAIN_CONTEXT_ID,
    recommendation_id: LOCAL_CHAIN_RECOMMENDATION_ID, rank: 1, action_id: "local-task-followup",
    identity_digest: created.identity_digest }]);
  expect(brief.source.input.items).toHaveLength(1);
  expect(nextActionIds(db)).toEqual([`${LOCAL_CHAIN_RECOMMENDATION_ID}#1`]);
  expect(todayActionIds(db)).toEqual([`${LOCAL_CHAIN_RECOMMENDATION_ID}#1`]);
});

it("stops exposing current actions once the local source is held, without writing", async () => {
  const { db, store } = await chain();
  store.setHeld(LOCAL_CHAIN_TASK_ID, true);
  const before = writes(db);
  expect(() => new MorningRecommendationSource(db).generate(AT)).toThrow(MorningRecommendationSourceError);
  expect(nextActionIds(db)).toEqual([]);
  expect(todayActionIds(db)).toEqual([]);
  expect(projectRecommendations(db.db, AT).lifecycle_actions).toHaveLength(1);
  expect(projectRecommendations(db.db, AT).warnings).toEqual([
    { recommendation_id: LOCAL_CHAIN_RECOMMENDATION_ID, code: "RECOMMENDATION_SOURCE_UNAVAILABLE",
      deadline: "2026-08-28T12:02:59.999Z" }]);
  expect(writes(db)).toEqual(before);
});

it("stops exposing current actions after the collection is replaced or the observation is quarantined", async () => {
  const replaced = await chain();
  replaced.store.refresh(LOCAL_CHAIN_TASK_ID);
  expect(nextActionIds(replaced.db)).toEqual([]);
  expect(todayActionIds(replaced.db)).toEqual([]);

  const quarantined = await chain();
  new MemoryProjectionAuthority(quarantined.db).quarantineUnresolved({ kind: "observation",
    id: quarantined.observation.id, component_id: quarantined.observation.id }, new Date(AT));
  expect(nextActionIds(quarantined.db)).toEqual([]);
  expect(todayActionIds(quarantined.db)).toEqual([]);
});

it("keeps assembled contexts out of recommendations while their evidence kinds stay uncitable", async () => {
  const db = open();
  const { observation } = await admitLocalChainObservation(db);
  const context = assemblePersonalContext({ purpose: "daily_prioritization", query: "what now?", clock: AT,
    expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 4096 },
    observations: [observation], pending_authority_refs: [], memories: [localChainConfirmedMemory] });
  expect(context.payload.state).toBe("sufficient");
  expect(context.payload.included_observation_refs).toEqual([observation.id]);
  expect(context.evidence.map(item => item.kind)).toEqual(["context_observation", "confirmed_memory"]);
  const memoryEvidence = context.evidence[1];
  expect(memoryEvidence).toBeDefined();
  db.persistContextSnapshot({ context, memory_evidence: [{ memory_ref: LOCAL_CHAIN_PRINCIPLE_REF,
    evidence_id: memoryEvidence?.evidence_id ?? "", source_id: localChainConfirmedMemory.source_id,
    digest: localChainConfirmedMemory.digest, observed_at: localChainConfirmedMemory.observed_at,
    fresh_until: localChainConfirmedMemory.fresh_until }] }, AT);
  // Citation binding requires linux_live_fact / user_confirmed_principle / owner_decision evidence kinds.
  expect(db.db.prepare("SELECT evidence_kind FROM personal_context_evidence WHERE context_id=? ORDER BY position")
    .pluck().all(context.id)).toEqual(["context_observation", "confirmed_memory"]);
});
