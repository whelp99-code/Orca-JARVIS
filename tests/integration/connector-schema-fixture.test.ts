import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { migratedConnectorDb } from "../fixtures/migrated-connector-db.js";

const schema = (db: AuthorityDb) => db.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const data = (db: AuthorityDb) => (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[]).map(({ name }) => [name,
  db.db.prepare(`SELECT * FROM ${JSON.stringify(name)}`).all().map(row => {
    const timestamp = name === "schema_migrations" ? "applied_at"
      : name === "remote_auth_legacy_quarantine_v2" ? "installed_at" : null;
    if (timestamp === null) return row;
    const stable = { ...row as Record<string, unknown> };
    expect(new Date(String(stable[timestamp])).toISOString()).toBe(stable[timestamp]);
    delete stable[timestamp]; return stable;
  })]);
const close = (db: AuthorityDb) => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); };

it("retains the complete fresh schema and migration default data", async () => {
  const fresh = new AuthorityDb(":memory:"); await fresh.migrate();
  const copy = await migratedConnectorDb();
  try {
    expect(schema(copy)).toEqual(schema(fresh)); expect(data(copy)).toEqual(data(fresh));
    expect(copy.db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(copy.db.pragma("foreign_key_check")).toEqual([]);
  } finally { fresh.close(); close(copy); }
});

it("isolates simultaneous fixture writes, schema mutations and checksum damage", async () => {
  const [a, b] = await Promise.all([migratedConnectorDb(), migratedConnectorDb()]);
  let c: AuthorityDb | undefined;
  try {
    expect(a.filename).not.toBe(b.filename);
    a.db.exec("CREATE TABLE fixture_private(value TEXT); INSERT INTO fixture_private VALUES('private')");
    a.db.prepare("UPDATE schema_migrations SET checksum='changed' WHERE id=?").run("001_authority.sql");
    await expect(a.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    await b.assertMigrationsReady(); c = await migratedConnectorDb();
    for (const db of [b, c]) {
      expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_private'").all()).toEqual([]);
      expect(db.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE checksum='changed'").get()).toEqual({ n: 0 });
    }
  } finally { close(a); close(b); if (c) close(c); }
});
