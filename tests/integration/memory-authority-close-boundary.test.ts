import Database from "better-sqlite3";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { MemoryCorrectionCancellationResultStore } from "../../src/memory-correction-cancellation-result-store.js";
import { cancellationResultFixture } from "../fixtures/memory-cancellation-result.js";
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { readSwapBarrier } from "../../src/authority-database-swap-barrier.js";

const intent = "at-native-close";
const insert = `INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,
  payload_digest,idempotency_key,state,created_at) VALUES(?, 'task:late', 'dispatch', ?,
  'sha256:at-close', ?, 'pending', '2026-08-28T12:00:00.000Z')`;

it.each([
  { mode: "insert", boundary: "source" }, { mode: "update", boundary: "source" },
  { mode: "insert", boundary: "probe" }, { mode: "update", boundary: "probe" },
] as const)("preserves a committed $mode inside $boundary native close", async ({ mode, boundary }) => {
  const f = await cancellationResultFixture();
  // The fixture allows publication; it does not establish real OS isolation.
  withProvableExclusion(f.databaseRuntime);
  new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock)
    .record(f.record.correction_id, f.result);
  if (mode === "update") f.db.db.prepare(insert).run(intent, '{"phase":"before"}', intent);
  const source = f.db.filename;
  const originalInode = statSync(source, { bigint: true }).ino;
  const originalClose = Database.prototype.close;
  let injected = 0;
  let closes = 0;
  let committed = false;
  let refusal: string | undefined;
  Database.prototype.close = function patched(this: Database.Database) {
    const result = originalClose.call(this);
    if (this.name === source) closes += 1;
    if (injected === 0 && this.name === source && closes === (boundary === "source" ? 1 : 2)) {
      injected += 1;
      const late = new Database(source);
      try {
        late.pragma("journal_mode = WAL");
        if (mode === "insert") late.prepare(insert).run(intent, '{"phase":"after"}', intent);
        else late.prepare("UPDATE gjc_intents SET attempts=1 WHERE intent_id=?").run(intent);
        committed = true;
      } catch (error) {
        refusal = String(Reflect.get(error as object, "code") ?? (error as Error).message);
      } finally { late.close(); }
    }
    return result;
  } as typeof Database.prototype.close;
  try {
    const outcome = await f.runtime.compactor.compactCancellation(f.record.correction_id)
      .catch((error: unknown) => error);
    expect(injected).toBe(1);
    if (!committed) expect(refusal).toMatch(/SQLITE_BUSY|SQLITE_LOCKED|locked/);
    const locations = [source, ...readdirSync(dirname(source))
      .filter(name => name.endsWith(".retired")).map(name => join(dirname(source), name))];
    const survives = locations.some(path => {
      const probe = new Database(path, { readonly: true, fileMustExist: true });
      try {
        return mode === "update"
          ? probe.prepare("SELECT attempts FROM gjc_intents WHERE intent_id=?").pluck().get(intent) === 1
          : probe.prepare("SELECT payload_json FROM gjc_intents WHERE intent_id=?")
            .pluck().get(intent) === '{"phase":"after"}';
      } finally { probe.close(); }
    });
    expect(survives, JSON.stringify({ committed, refusal,
      outcome: outcome instanceof Error ? outcome.message : "ok" })).toBe(committed);
    if (committed) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(boundary === "source"
        ? "MEMORY_SOURCE_CHANGED_DURING_CLOSE" : "MEMORY_PURGE_LATE_COMMIT_UNRESOLVED");
      if (boundary === "source") expect(statSync(source, { bigint: true }).ino).toBe(originalInode);
    }
    expect(readSwapBarrier(source)).toBeUndefined();
    expect(f.db.db.open).toBe(true);
    expect(f.db.db.inTransaction).toBe(false);
    f.db.db.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally {
    Database.prototype.close = originalClose;
    await f.close();
  }
}, 60_000);
