import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";

it("rejects a newer database before an older migration set can report ready or apply changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "migration-version-boundary-"));
  const first = join(root, "001_fixture.sql"), future = join(root, "002_future.sql");
  writeFileSync(first, "CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('original');");
  writeFileSync(future, "CREATE TABLE future(value TEXT);");
  const db = new AuthorityDb(join(root, "authority.sqlite"), root);
  try {
    await db.migrate(); await db.assertMigrationsReady();
    rmSync(future);
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_VERSION_UNSUPPORTED" });
    // An unrelated pending migration must not be applied on unsupported history.
    writeFileSync(join(root, "003_pending.sql"), "DELETE FROM preserved;");
    await expect(db.migrate()).rejects.toMatchObject({ code: "MIGRATION_VERSION_UNSUPPORTED" });
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.db.prepare("SELECT * FROM preserved").all()).toEqual([{ value: "original" }]);
    expect(db.db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
    expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
