import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, canonicalize } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const MIGRATION = "036_notification_intent_immutable_delete.sql";
const CHECKSUM = "a36ba7cecf63f28cc9fa7f6be6ce9aed0e7e093681d754fb1e897605b807aeb2";
const T0 = "2026-08-28T12:00:00.000Z";
const T1 = "2026-08-28T13:30:00.000Z";
function insertIntent(db: AuthorityDb): void {
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
    redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ntf:immutable", "thread:immutable", "idem:immutable", "dedup:immutable", "action", "mac",
      "Review a protected owner decision.", `/decisions/${"a".repeat(64)}`, "created", T1, T0, T0);
  db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:immutable'").run(T0);
}
function migrationRoot(upperBound: string): { readonly root: string; readonly migrations: string } {
  const root = mkdtempSync(join(tmpdir(), "task22-migration-")); const migrations = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
  for (const file of readdirSync(migrations)) if (file.endsWith(".sql") && file > upperBound) rmSync(join(migrations, file));
  return { root, migrations };
}

describe("migration 036 notification intent immutable delete", () => {
  it("is byte-pinned, source-built, fresh, and idempotent without schema expansion", async () => {
    // Given: tracked source bytes and a fresh database.
    const source = readFileSync(join(process.cwd(), "migrations", MIGRATION)); const db = new AuthorityDb(tempDb());
    // When: migration is applied and reapplied.
    await db.migrate(); const objects = db.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    await db.migrate();
    // Then: exact bytes are pinned and exactly one intended trigger exists.
    expect(createHash("sha256").update(source).digest("hex")).toBe(CHECKSUM);
    expect(readFileSync(join(process.cwd(), "dist", "migrations", MIGRATION))).toEqual(source);
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='notification_intents' AND name=?")
      .all("notification_intents_immutable_delete")).toEqual([{ name: "notification_intents_immutable_delete" }]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?").get(MIGRATION)).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(objects);
    db.close();
  });

  it("upgrades exact through-035 bytes without changing intent rows, tables, or columns", async () => {
    const fixture = migrationRoot("035_daily_loop_durable_guards.sql"); const path = join(fixture.root, "authority.sqlite");
    const db = new AuthorityDb(path, fixture.migrations);
    try {
      await db.migrate(); insertIntent(db);
      const row = canonicalize(db.db.prepare("SELECT * FROM notification_intents WHERE intent_id='ntf:immutable'").get());
      const tables = canonicalize(db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all());
      const columns = canonicalize(db.db.prepare("PRAGMA table_info(notification_intents)").all());
      cpSync(join(process.cwd(), "migrations", MIGRATION), join(fixture.migrations, MIGRATION));
      await db.migrate();
      expect(canonicalize(db.db.prepare("SELECT * FROM notification_intents WHERE intent_id='ntf:immutable'").get())).toBe(row);
      expect(canonicalize(db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all())).toBe(tables);
      expect(canonicalize(db.db.prepare("PRAGMA table_info(notification_intents)").all())).toBe(columns);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?").get(MIGRATION)).toEqual({ n: 1 });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects second-connection delete and delete-reinsert after reopen with the exact row unchanged", async () => {
    const path = tempDb(); const db = new AuthorityDb(path); await db.migrate(); insertIntent(db);
    const before = canonicalize(db.db.prepare("SELECT * FROM notification_intents WHERE intent_id='ntf:immutable'").get());
    const second = new AuthorityDb(path);
    try {
      expect(() => second.db.prepare("DELETE FROM notification_intents WHERE intent_id='ntf:immutable'").run())
        .toThrow("immutable notification intent");
      const reopened = new AuthorityDb(path);
      expect(() => reopened.db.exec(`DELETE FROM notification_intents WHERE intent_id='ntf:immutable';
        INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,state,
          expires_at,created_at,updated_at) VALUES('ntf:immutable','changed','changed','changed','info','mac','Changed','/decisions/changed',
          'created','${T1}','${T0}','${T0}')`)).toThrow("immutable notification intent");
      expect(canonicalize(reopened.db.prepare("SELECT * FROM notification_intents WHERE intent_id='ntf:immutable'").get())).toBe(before);
      expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 1 }); reopened.close();
    } finally { second.close(); db.close(); }
  });

  it("fails readiness when the pinned 036 bytes change", async () => {
    const fixture = migrationRoot(MIGRATION); const db = new AuthorityDb(tempDb(), fixture.migrations);
    try {
      await db.migrate(); appendFileSync(join(fixture.migrations, MIGRATION), "\n-- mutation\n");
      await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });
});
