/* global process */
// Runs one retention rebuild and stops dead at a named point, so the parent can kill it there.
//
// The stop points are the ones a crash can leave evidence at: the claim is recorded, the copy is
// half written, the candidate is verified, the swap is one step away, the swap is done. Each is
// reached by wrapping statement preparation rather than by timing, and the parent kills the
// process only after it has read the line printed at the point, so no run depends on a sleep.
import { writeSync } from "node:fs";
import Database from "better-sqlite3";
import { AuthorityDb } from "../../dist/src/db.js";
import { AuthorityDatabaseRuntime } from "../../dist/src/authority-database-runtime.js";
import { applyLocalObservationRetention } from "../../dist/src/local-observation-retention.js";
import { applyRetentionCandidate } from "../../dist/src/local-observation-retention-swap.js";

const [databasePath, candidatePath, cutoff, barrier, registryRoot, now] = process.argv.slice(2);

const hold = () => {
  writeSync(1, `${barrier}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const stopPoint = sql => {
  if (/^\s*ATTACH DATABASE/i.test(sql)) return "during_copy";
  if (/UPDATE local_retention_claim_intents SET claim_device/i.test(sql)) return "before_identity";
  if (/INSERT INTO local_retention_operations/i.test(sql)) {
    return /'applied'/.test(sql) ? "before_swap" : "after_claim";
  }
  if (/UPDATE local_retention_operations SET state='verified'/i.test(sql)) return "after_verify";
  return undefined;
};

const prepare = Database.prototype.prepare;
Database.prototype.prepare = function wrapped(sql, ...rest) {
  const statement = prepare.call(this, sql, ...rest);
  if (stopPoint(sql) !== barrier) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    // The applied record is the last thing written before the rename: stopping in front of it is
    // the moment the swap is about to happen, stopping behind the others is just after each.
    if (barrier === "before_swap" || barrier === "before_identity") hold();
    const result = run(...args);
    hold();
    return result;
  };
  return statement;
};

const authority = new AuthorityDb(databasePath);
const application = await applyLocalObservationRetention(
  authority, cutoff, candidatePath, new Date(now));
const runtime = new AuthorityDatabaseRuntime(authority, {
  registry_root: registryRoot, watchdog_ms: 1000,
});
const result = await runtime.quiesce("local_retention",
  async () => applyRetentionCandidate(runtime, application, new Date(now)));
if (barrier === "after_swap") hold();
writeSync(1, `done ${JSON.stringify(result)}\n`);
authority.close();
