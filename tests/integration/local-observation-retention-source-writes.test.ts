import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { applyLocalObservationRetention } from "../../src/local-observation-retention.js";
import { localChainCutoff, localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const sha = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const bytes = (path: string): number | null => existsSync(path) ? statSync(path).size : null;
const rows = (db: AuthorityDb): Record<string, number> => Object.fromEntries(
  ["personal_observations", "personal_context_observations", "personal_context_snapshots",
    "personal_recommendations", "notification_intents", "personal_context_audit_events",
    "gjc_intents"].map(table =>
    [table, Number(db.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get())]));
const operations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM local_retention_operations").pluck().get());

// The apply reads the source through SQLite's backup API into a snapshot it owns, and the rebuild
// adapter checkpoints that snapshot rather than the source. Every signal is measured separately so
// no claim can hide behind another: the earlier contract, where the source's own write-ahead log
// was truncated by the apply, no longer holds for this path.
it("leaves the source untouched, logically and physically, while it copies", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const cutoff = localChainCutoff(db);
  // Hold the write-ahead log so the source has un-checkpointed content when the build starts.
  db.db.pragma("wal_autocheckpoint=0");
  db.db.pragma("wal_checkpoint(TRUNCATE)");
  db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
    idempotency_key,state,created_at) VALUES('wal','task:wal','dispatch','{}','sha256:fixture','wal',
    'pending','2026-08-28T11:00:00.000Z')`).run();

  const before = {
    changes: Number(db.db.prepare("SELECT total_changes()").pluck().get()),
    rows: rows(db),
    main: sha(db.filename),
    wal: bytes(`${db.filename}-wal`),
    shm: bytes(`${db.filename}-shm`),
  };
  expect(before.wal).toBeGreaterThan(0);

  const application = await applyLocalObservationRetention(db, cutoff,
    join(dirname(db.filename), "source-write-candidate.sqlite"));
  expect(application.build.foreign_key_errors).toBe(0);

  const after = {
    changes: Number(db.db.prepare("SELECT total_changes()").pluck().get()),
    rows: rows(db),
    main: sha(db.filename),
    wal: bytes(`${db.filename}-wal`),
    shm: bytes(`${db.filename}-shm`),
  };
  // The only writes the apply makes to the source are its own claim ledger: the intent that
  // announces the directory, the identity the create produced, the operation row, the delete that
  // spends the intent, and the verdict.
  expect(after.changes).toBe(before.changes + 5);
  expect(operations(db)).toBe(1);
  expect(Number(db.db.prepare("SELECT COUNT(*) FROM local_retention_claim_intents").pluck().get()))
    .toBe(0);
  expect(String(db.db.prepare("SELECT state FROM local_retention_operations").pluck().get()))
    .toBe("verified");
  // No data table moves: the apply removes nothing from the source.
  expect(after.rows).toEqual(before.rows);
  // The checkpoint lands on the snapshot this call owns, so the source's main file is untouched
  // and only its write-ahead log grows by the operation record.
  expect(after.main).toBe(before.main);
  expect(after.wal).toBeGreaterThan(before.wal ?? 0);
  expect(after.shm).not.toBeNull();
  // The snapshot the apply took is its own and does not survive the call.
  for (const suffix of ["", "-wal", "-shm"]) {
    expect(existsSync(`${application.build.fresh_path}.selected-source${suffix}`)).toBe(false);
  }
  // A fresh connection reads exactly the same logical content afterwards.
  const reopened = new AuthorityDb(db.filename); opened.push(reopened);
  expect(rows(reopened)).toEqual(before.rows);
  expect(String(reopened.db.prepare(
    "SELECT observation_id FROM personal_observations WHERE source_id='src:pos:v1:task-timeline:local'")
    .pluck().get())).toBe(chain.observation.id);
});
