import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import {
  assertCandidateMatchesCopyPlan,
} from "../../src/local-observation-retention-candidate.js";
import { selectLocalObservationRetention } from "../../src/local-observation-retention-selection.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const count = (db: AuthorityDb, sql: string): number => Number(db.db.prepare(sql).pluck().get());

/** Drops the immutable triggers of one table on a throwaway candidate so a test can tamper. */
function unlock(db: AuthorityDb, table: string): void {
  for (const name of db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").pluck().all(table) as string[]) {
    db.db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
  }
}

/** A source with one full chain, the cutoff that selects it, and a candidate built by the adapter. */
async function built(blockedFromCutoff: boolean) {
  const source = new AuthorityDb(tempDb()); opened.push(source);
  const chain = await localObservationChain(source);
  // Past both of the chain's observations: a cutoff reaching only the local collection would
  // correctly retain the group, leaving this plan nothing to remove.
  const cutoff = String(source.db.prepare(
    "SELECT MAX(expires_at) FROM personal_observations").pluck().get());
  const selection = selectLocalObservationRetention(source.db, cutoff);
  const blocked = blockedFromCutoff ? selection.blocked : [];
  const destination = join(dirname(source.filename), `plan-${blockedFromCutoff ? "cut" : "keep"}.sqlite`);
  const build = await buildFreshAuthority(source, destination,
    { blocked_projections: blocked, sensitive_material: [] });
  return { source, chain, blocked, destination, build };
}

it("accepts the candidate the copier's own plan produces, with and without removals", async () => {
  const keep = await built(false);
  expect(() => assertCandidateMatchesCopyPlan(keep.source, keep.destination, [], keep.build.result_generation))
    .not.toThrow();

  const cut = await built(true);
  expect(cut.blocked).toHaveLength(3);
  expect(() => assertCandidateMatchesCopyPlan(cut.source, cut.destination, cut.blocked,
    cut.build.result_generation)).not.toThrow();
  const candidate = new AuthorityDb(cut.destination); opened.push(candidate);
  // The selected group is gone and the audit rows that name it are kept: that is the copier's rule.
  expect(count(candidate, "SELECT COUNT(*) FROM personal_recommendations")).toBe(0);
  expect(count(candidate, "SELECT COUNT(*) FROM personal_context_audit_events"))
    .toBe(count(cut.source, "SELECT COUNT(*) FROM personal_context_audit_events"));
}, 60_000);

it("rejects a candidate that kept rows the selection chose to remove", async () => {
  const keep = await built(false);
  const cut = await built(true);
  // The first candidate removed nothing; checked against a plan that removes the group it is wrong.
  expect(() => assertCandidateMatchesCopyPlan(keep.source, keep.destination, cut.blocked,
    keep.build.result_generation)).toThrow("LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW");
}, 60_000);

it("rejects a candidate that lost an audit row naming a removed context", async () => {
  const cut = await built(true);
  const candidate = new AuthorityDb(cut.destination); opened.push(candidate);
  unlock(candidate, "personal_context_audit_events");
  const removed = candidate.db.prepare(
    `DELETE FROM personal_context_audit_events WHERE rowid=(
       SELECT MIN(rowid) FROM personal_context_audit_events)`).run().changes;
  expect(removed).toBe(1);
  candidate.close();

  expect(() => assertCandidateMatchesCopyPlan(cut.source, cut.destination, cut.blocked,
    cut.build.result_generation)).toThrow("LOCAL_RETENTION_CANDIDATE_MISSING_ROW");
}, 60_000);

it("rejects a candidate whose INTEGER differs only beyond the safe range", async () => {
  const keep = await built(false);
  // Two integers that JavaScript rounds to the same number. The column is a real INTEGER, so the
  // rounding happens on the way out of SQLite rather than in a text literal.
  unlock(keep.source, "local_timeline_subjects");
  expect(keep.source.db.prepare("UPDATE local_timeline_subjects SET generation=9007199254740992")
    .run().changes).toBeGreaterThan(0);
  const candidate = new AuthorityDb(keep.destination); opened.push(candidate);
  unlock(candidate, "local_timeline_subjects");
  expect(candidate.db.prepare("UPDATE local_timeline_subjects SET generation=9007199254740993")
    .run().changes).toBeGreaterThan(0);
  candidate.close();

  expect(() => assertCandidateMatchesCopyPlan(keep.source, keep.destination, [],
    keep.build.result_generation))
    .toThrow(/LOCAL_RETENTION_CANDIDATE_(FOREIGN_ROW|MISSING_ROW)/);
}, 60_000);

// Values that differ only by separators, quoting, emptiness, type or precision must not collide.
it.each([
  ["separator and token", `UPDATE gjc_intents SET payload_json='{"a":"x s:y"}'`],
  ["quote", `UPDATE gjc_intents SET payload_json='{"a":"\\"y\\""}'`],
  ["empty string", "UPDATE gjc_intents SET receipt_json=''"],
  ["null", "UPDATE gjc_intents SET continuation_id=NULL"],
  ["blob", "UPDATE gjc_intents SET payload_json=CAST('{}' AS BLOB)"],
  ["numeric", "UPDATE gjc_intents SET payload_json=0"],
  ["large integer", "UPDATE gjc_intents SET payload_json=9007199254740993"],
])("rejects a candidate whose %s value differs from the source", async (_label, mutation) => {
  const keep = await built(false);
  const candidate = new AuthorityDb(keep.destination); opened.push(candidate);
  unlock(candidate, "gjc_intents");
  expect(candidate.db.prepare(mutation).run().changes).toBeGreaterThan(0);
  candidate.close();

  expect(() => assertCandidateMatchesCopyPlan(keep.source, keep.destination, [],
    keep.build.result_generation))
    .toThrow(/LOCAL_RETENTION_CANDIDATE_(FOREIGN_ROW|MISSING_ROW)/);
}, 60_000);

it("rejects a candidate whose table set or generation history was altered", async () => {
  const dropped = await built(false);
  const candidate = new AuthorityDb(dropped.destination); opened.push(candidate);
  candidate.db.exec("DROP TABLE IF EXISTS live_supervisor_reports");
  candidate.close();
  expect(() => assertCandidateMatchesCopyPlan(dropped.source, dropped.destination, [],
    dropped.build.result_generation)).toThrow("LOCAL_RETENTION_CANDIDATE_SCHEMA_INVALID");

  const generations = await built(false);
  const other = new AuthorityDb(generations.destination); opened.push(other);
  unlock(other, "memory_database_generations");
  other.db.prepare("UPDATE memory_database_generations SET state='retired' WHERE state='active'").run();
  other.close();
  expect(() => assertCandidateMatchesCopyPlan(generations.source, generations.destination, [],
    generations.build.result_generation))
    .toThrow("LOCAL_RETENTION_CANDIDATE_GENERATION_INVALID");
}, 60_000);
