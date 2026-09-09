import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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


it("preserves the recovered deployed migration bytes and populated performance records on replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "migration-recovered-028-"));
  const bytes = readFileSync(new URL("../../migrations/028_budgeted_evolution_memory.sql", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe("55faa41aa1c3c0b2c78ebfa4f59cd9daf6e4793deac91f39bfb3ea7e00955386");
  writeFileSync(join(root, "028_budgeted_evolution_memory.sql"), bytes);
  const db = new AuthorityDb(join(root, "authority.sqlite"), root);
  try {
    await db.migrate();
    db.db.prepare("INSERT INTO evolution_performance_records VALUES (?,?,?,?,?,?,?,?)")
      .run("fixture-task", "fixture-candidate", 2, 1, 0.5, 1, 10, "2026-08-21T00:00:00.000Z");
    const before = db.db.prepare("SELECT * FROM evolution_performance_records").all();
    await db.migrate(); await db.assertMigrationsReady();
    expect(db.db.prepare("SELECT * FROM evolution_performance_records").all()).toEqual(before);
    expect(() => db.db.prepare("UPDATE evolution_performance_records SET successes=3").run()).toThrow();
    expect(db.db.prepare("SELECT * FROM evolution_performance_records").all()).toEqual(before);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
