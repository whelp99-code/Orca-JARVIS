import Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { applyLocalObservationRetention } from "../../src/local-observation-retention.js";
import { applyRetentionCandidate } from "../../src/local-observation-retention-swap.js";
import { readSwapBarrier } from "../../src/authority-database-swap-barrier.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { tempDb } from "../helpers.js";

it.each([0, 1, 2, 3, 4])("keeps a retention source commit inside native close #%i (0 = no writer)", async closeNumber => {
  const db = new AuthorityDb(tempDb());
  const chain = await localObservationChain(db);
  const source = db.filename;
  const registry = join(dirname(source), "registry");
  mkdirSync(registry);
  const runtime = withProvableExclusion(new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 5000 }));
  const originalClose = Database.prototype.close;
  let closes = 0;
  let committed = false;
  let refusal: string | undefined;
  try {
    const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
      .pluck().get(chain.observation.id));
    const application = await applyLocalObservationRetention(db, cutoff, join(dirname(source), "candidate"));
    const originalInode = statSync(source, { bigint: true }).ino;
    Database.prototype.close = function patched(this: Database.Database) {
      const result = originalClose.call(this);
      if (this.name === source && ++closes === closeNumber) {
        const late = new Database(source);
        try {
          late.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,
            payload_digest,idempotency_key,state,created_at) VALUES('retention-close','task:late',
            'dispatch','{}','sha256:close','retention-close','pending','2026-08-28T12:00:00.000Z')`).run();
          committed = true;
        } catch (error) { refusal = String(Reflect.get(error as object, "code")); }
        finally { late.close(); }
      }
      return result;
    } as typeof Database.prototype.close;
    const outcome = await runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, new Date())).catch((error: unknown) => error);
    expect(closes).toBeGreaterThanOrEqual(closeNumber);
    if (!committed && closeNumber !== 0) expect(refusal).toMatch(/SQLITE_BUSY|SQLITE_LOCKED/);
    const locations = [source, ...readdirSync(dirname(source)).filter(name => name.endsWith(".retired"))
      .map(name => join(dirname(source), name))];
    const survives = locations.some(path => {
      const probe = new Database(path, { readonly: true, fileMustExist: true });
      try { return probe.prepare("SELECT count(*) FROM gjc_intents WHERE intent_id='retention-close'")
        .pluck().get() === 1; } finally { probe.close(); }
    });
    expect(survives, JSON.stringify({ closeNumber, committed, outcome:
      outcome instanceof Error ? outcome.message : "ok" })).toBe(committed);
    if (closeNumber === 1 && committed) expect(statSync(source, { bigint: true }).ino).toBe(originalInode);
    if (closeNumber === 0) {
      expect(outcome).not.toBeInstanceOf(Error);
      expect(statSync(source, { bigint: true }).ino).not.toBe(originalInode);
      expect(locations).toHaveLength(1);
    }
    expect(readSwapBarrier(source)).toBeUndefined();
    expect(db.db.open).toBe(true);
    expect(db.db.inTransaction).toBe(false);
  } finally { Database.prototype.close = originalClose; await runtime.close(); }
}, 60_000);
