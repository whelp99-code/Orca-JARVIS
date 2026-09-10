import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import {
  applyLocalObservationRetention, findDanglingRetentionReferences,
  verifyLocalObservationRetentionCandidate,
} from "../../src/local-observation-retention.js";
import { localObservationChain, LOCAL_CHAIN_AT } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const count = (db: AuthorityDb, table: string): number =>
  Number(db.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());

function addIntent(db: AuthorityDb, recommendation: string, suffix = "fixture"): void {
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,
    urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,'action','mac','owner decision waiting',?,'created',?,?,?)`).run(
    `nin:pos:v1:${suffix}`, "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", `idem:notify:${suffix}`,
    `dedup:notify:${suffix}`, `/recommendations/${encodeURIComponent(recommendation)}`,
    "2026-08-28T13:00:00.000Z", LOCAL_CHAIN_AT, LOCAL_CHAIN_AT);
}

/** A source holding one full observation chain, its cutoff, and a free destination path. */
async function fixture() {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  return { db, chain, cutoff, destination: join(dirname(db.filename), "candidate.sqlite") };
}

// buildFreshAuthority yields at `await fresh.migrate()`, so a write landing after the selection is
// still copied. Driving the interleaving from that yield is deterministic - no timer, no sleep.
it("refuses a candidate whose source changed between selection and copy", async () => {
  const f = await fixture();
  const pending = applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  addIntent(f.db, f.chain.created.recommendation.id);

  await expect(pending).rejects.toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  // An interrupted apply leaves no candidate to mistake for a usable one, and no source damage.
  expect(existsSync(f.destination)).toBe(false);
  expect(count(f.db, "personal_recommendations")).toBe(1);
  expect(count(f.db, "notification_intents")).toBe(1);
  expect(count(f.db, "personal_observations")).toBe(1);
});

it("refuses a candidate whose source a second connection changed during the copy", async () => {
  const f = await fixture();
  const writer = new AuthorityDb(f.db.filename); opened.push(writer);
  const pending = applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  addIntent(writer, f.chain.created.recommendation.id, "second-connection");

  await expect(pending).rejects.toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  expect(existsSync(f.destination)).toBe(false);
  expect(count(f.db, "personal_recommendations")).toBe(1);
});

// notification_intents references a recommendation only through deep_link text: no foreign key,
// no index. foreign_key_check therefore reports a clean candidate while the reference dangles.
it("finds the dangling reference a clean foreign_key_check cannot", async () => {
  const f = await fixture();
  const recommendation = f.chain.created.recommendation.id;
  addIntent(f.db, recommendation);
  const blocked = [
    { kind: "observation" as const, id: f.chain.observation.id, component_id: f.chain.observation.id },
    { kind: "context" as const, id: f.chain.context.id, component_id: f.chain.context.id },
    { kind: "recommendation" as const, id: recommendation, component_id: recommendation }];
  const build = await buildFreshAuthority(f.db, f.destination,
    { blocked_projections: blocked, sensitive_material: [] });
  expect(build.foreign_key_errors).toBe(0);

  const candidate = new AuthorityDb(f.destination); opened.push(candidate);
  expect(count(candidate, "personal_recommendations")).toBe(0);
  expect(count(candidate, "notification_intents")).toBe(1);
  expect(findDanglingRetentionReferences(candidate.db, blocked)).toEqual([recommendation]);
  // A group that survives the cutoff is not reported: the check names broken references only.
  expect(findDanglingRetentionReferences(candidate.db, [])).toEqual([]);
});

it("reports a candidate stale once the source moves past the fence it was built from", async () => {
  const f = await fixture();
  const application = await applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  expect(application.build.foreign_key_errors).toBe(0);
  // The candidate is the source as of its fence, so an unchanged source still verifies.
  expect(() => verifyLocalObservationRetentionCandidate(f.db, application)).not.toThrow();

  addIntent(f.db, f.chain.created.recommendation.id, "after-candidate");
  expect(() => verifyLocalObservationRetentionCandidate(f.db, application))
    .toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  // Detection happens before any swap, so both files stay exactly where the caller left them.
  expect(existsSync(f.destination)).toBe(true);
  expect(count(f.db, "personal_recommendations")).toBe(1);
});
