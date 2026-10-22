import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

function tamperPreservingSizeAndMtime(path: string, mutate: (bytes: Buffer) => void): void {
  const before = statSync(path);
  const bytes = readFileSync(path);
  mutate(bytes);
  writeFileSync(path, bytes);
  utimesSync(path, before.atime, before.mtime);
  const after = statSync(path);
  expect(after.size).toBe(before.size);
  expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThanOrEqual(1);
}

describe("MigrationStore applied migration checksum", () => {
  it("serializes callers that classified the same migration as pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-concurrent-migration-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations);
    cpSync(join(process.cwd(), "migrations", "001_authority.sql"), join(migrations, "001_authority.sql"));
    const databasePath = join(root, "authority.sqlite");
    const first = new AuthorityDb(databasePath, migrations);
    const second = new AuthorityDb(databasePath, migrations);
    try {
      await Promise.all([first.migrate(), second.migrate()]);
      expect(first.db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
      await second.assertMigrationsReady();
    } finally {
      first.close();
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects in-place byte changes on a second migrate() in the same process", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-applied-checksum-"));
    const migrations = join(root, "migrations");
    mkdirSync(migrations, { recursive: true });
    cpSync(join(process.cwd(), "migrations", "001_authority.sql"), join(migrations, "001_authority.sql"));
    const migrationPath = join(migrations, "001_authority.sql");
    const databasePath = tempDb();
    const db = new AuthorityDb(databasePath, migrations);
    await db.migrate();
    await db.migrate();
    const digestBefore = createHash("sha256").update(readFileSync(migrationPath)).digest("hex");
    tamperPreservingSizeAndMtime(migrationPath, bytes => {
      const idx = bytes.indexOf("schema_migrations");
      if (idx < 0) throw new Error("fixture layout changed");
      bytes[idx] = bytes[idx] === 115 ? 116 : 115;
    });
    const digestAfter = createHash("sha256").update(readFileSync(migrationPath)).digest("hex");
    expect(digestAfter).not.toBe(digestBefore);
    try {
      await expect(db.migrate()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
