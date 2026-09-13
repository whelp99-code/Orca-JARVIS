import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MorningRecommendationSource, MorningRecommendationSourceError } from "../../src/morning-recommendation-source.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import {
  extendLocalObservationChain,
  localChainIds,
  localObservationChain,
  LOCAL_CHAIN_AT,
} from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const scalar = (db: AuthorityDb, sql: string): number => Number(db.db.prepare(sql).pluck().get());
const todayActions = (db: AuthorityDb) => (todayProjection(db, new Date(AT)) as
  Record<string, unknown>)["next_actions"] as readonly unknown[];

it("keeps actionable output at one item while repeated producer cycles pile up storage", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await localObservationChain(db);

  for (let cycle = 1; cycle <= 3; cycle++) {
    if (cycle > 1) extendLocalObservationChain(db, cycle - 1);
    const stored = cycle;
    // Every cycle stores another immutable row set for byte-identical source content: the local
    // timeline collection, and the live fact that cycle's recommendation cites beside it.
    expect(scalar(db, `SELECT COUNT(*) FROM personal_observations
      WHERE source_id='src:pos:v1:task-timeline:local'`)).toBe(stored);
    expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(stored * 2);
    expect(scalar(db, "SELECT COUNT(*) FROM personal_context_snapshots")).toBe(stored);
    expect(scalar(db, "SELECT COUNT(*) FROM personal_recommendations")).toBe(stored);
    expect(scalar(db, `SELECT COUNT(DISTINCT json_extract(canonical_envelope_json,
      '$.payload.value.collection_content_digest')) FROM personal_observations`)).toBe(1);

    // Only the newest producer stays current in every actionable read.
    const newest = localChainIds(cycle - 1).recommendationId;
    const projection = projectRecommendations(db, AT);
    expect(projection.next_actions.map(item => item.recommendation_id)).toEqual([newest]);
    expect(projection.lifecycle_actions).toHaveLength(stored);
    expect(projection.warnings.map(item => item.code))
      .toEqual(Array.from({ length: stored - 1 }, () => "RECOMMENDATION_SOURCE_UNAVAILABLE"));
    expect(todayActions(db)).toHaveLength(1);

    // A superseded local source excludes only its own recommendation; the brief still publishes.
    const generated = new MorningRecommendationSource(db).generate(AT);
    expect(generated.source.excluded.source_unavailable).toBe(stored - 1);
    expect(generated.source.input.items).toHaveLength(1);
    expect(generated.source.lineage.map(item => item.recommendation_id)).toEqual([newest]);
    expect(generated.brief.needs_you_first).toHaveLength(1);
    expect(generated.brief.needs_you_first[0]?.contributing_recommendation_ids).toEqual([newest]);
  }
});

it("excludes a quarantined observation from the brief instead of failing the whole read", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await localObservationChain(db);
  const second = extendLocalObservationChain(db, 1);
  new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "observation", id: second.observation.id,
    component_id: second.observation.id }, new Date(AT));
  const generated = new MorningRecommendationSource(db).generate(AT);
  expect(generated.source.excluded.source_unavailable).toBe(2);
  expect(generated.source.input.items).toEqual([]);
  expect(generated.brief.abstention_reasons).toEqual(["no_authoritative_data"]);
  expect(projectRecommendations(db, AT).next_actions).toEqual([]);
});

it("still fails closed when a cited context envelope is altered rather than merely superseded", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const triggers = db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='personal_context_snapshots'",
  ).pluck().all() as string[];
  for (const name of triggers) db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  db.db.prepare("UPDATE personal_context_snapshots SET canonical_envelope_json='PRIVATE_BAD_SOURCE' WHERE context_id=?")
    .run(chain.context.id);
  // Source-availability exclusion must not soften integrity failures into a partial brief.
  expect(() => new MorningRecommendationSource(db).generate(AT)).toThrow(MorningRecommendationSourceError);
});
