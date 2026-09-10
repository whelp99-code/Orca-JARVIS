import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import {
  applyLocalObservationRetention, findDanglingRetentionReferences,
  verifyLocalObservationRetentionCandidate,
} from "../../src/local-observation-retention.js";
import {
  extendLocalObservationChain, localObservationChain, LOCAL_CHAIN_AT,
} from "../fixtures/local-observation-chain.js";
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
// The rebuild adapter copies by attaching source.filename through its own connection, so an
// open connection's counters cannot see a path replaced underneath it. The fence pins device and
// inode for exactly this case.
it("refuses a candidate when the source path is replaced during the copy", async () => {
  const f = await fixture();
  const replacement = join(dirname(f.db.filename), "replacement.sqlite");
  const other = new AuthorityDb(replacement);
  await other.migrate();
  other.db.pragma("wal_checkpoint(TRUNCATE)");
  other.close();

  const pending = applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  renameSync(replacement, f.db.filename);

  await expect(pending).rejects.toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  // Nothing usable is left behind: no candidate and no sidecar of one.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    expect(existsSync(`${f.destination}${suffix}`)).toBe(false);
  }
});

it("refuses a candidate when a second connection adds a context chain during the copy", async () => {
  const f = await fixture();
  const writer = new AuthorityDb(f.db.filename); opened.push(writer);
  const later = new Date(Date.parse(LOCAL_CHAIN_AT) + 600_000).toISOString();

  const pending = applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  const second = extendLocalObservationChain(writer, 1, later);

  await expect(pending).rejects.toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  expect(existsSync(f.destination)).toBe(false);
  // Both chains are still in the source: a refused apply removes nothing.
  expect(count(f.db, "personal_recommendations")).toBe(2);
  expect(count(f.db, "personal_observations")).toBe(2);
  expect(second.created.recommendation.id).not.toBe(f.chain.created.recommendation.id);
});

// A pathname replaced before the apply even starts is self-consistent: both fence reads see the
// new inode while the open connection still reads the old one. Only comparing the copy against
// the connection the selection used catches that.
it("refuses a candidate copied from a file the selection never read", async () => {
  const f = await fixture();
  const swapped = join(dirname(f.db.filename), "swapped.sqlite");
  const other = new AuthorityDb(swapped);
  await other.migrate();
  other.db.pragma("wal_checkpoint(TRUNCATE)");
  other.close();
  renameSync(swapped, f.db.filename);

  // Measured: the rebuild fails against the substituted file and the fence, which sees the open
  // connection notice the replacement, reports LOCAL_RETENTION_SOURCE_CHANGED. Either that or
  // LOCAL_RETENTION_CANDIDATE_MISMATCH is correct here - the copy check is what would catch a
  // substitution that still builds cleanly - and both leave the caller without a candidate.
  await expect(applyLocalObservationRetention(f.db, f.cutoff, f.destination))
    .rejects.toThrow(/LOCAL_RETENTION_(SOURCE_CHANGED|CANDIDATE_MISMATCH)/);
  expect(existsSync(f.destination)).toBe(false);
  // The selection's own connection still holds its rows; nothing was removed from it.
  expect(count(f.db, "personal_recommendations")).toBe(1);
});

it("still produces a candidate on a retry after a rejected apply", async () => {
  const f = await fixture();
  const pending = applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  addIntent(f.db, f.chain.created.recommendation.id);
  await expect(pending).rejects.toThrow("LOCAL_RETENTION_SOURCE_CHANGED");
  expect(existsSync(f.destination)).toBe(false);

  // Restart on the same destination: the refused attempt left neither a claim nor a candidate,
  // and the retry now sees the notification, so the selector retains the group instead.
  const retry = await applyLocalObservationRetention(f.db, f.cutoff, f.destination);
  expect(retry.selection.blocked).toEqual([]);
  expect(retry.selection.retained).toEqual([
    { observation_id: f.chain.observation.id, reason: "notification_addresses_recommendation" }]);
  expect(retry.build.foreign_key_errors).toBe(0);
  expect(existsSync(f.destination)).toBe(true);
});

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
