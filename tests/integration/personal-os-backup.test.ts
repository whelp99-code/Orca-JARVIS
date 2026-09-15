import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { backupSqlite, restoreSqlite } from "../../src/personal-os-backup.js";
import { PersonalOsError } from "../../src/personal-os-errors.js";
import { publishRelease } from "../../src/personal-os-release-publish.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

function scratch(): string {
  const root = personalOsScratch();
  scratchRoots.push(root);
  return root;
}

function seedDb(path: string, marker: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE sentinel(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO sentinel(id, value) VALUES(?, ?)").run("row-1", marker);
  db.close();
}

describe("personal-OS backup, restore, and publish", () => {
  it("takes an online backup and restores the durable sentinel into a new file", async () => {
    // Given
    const root = scratch();
    const source = join(root, "jarvis.sqlite");
    const backup = join(root, "backups", "jarvis.sqlite");
    const restored = join(root, "restore", "jarvis.sqlite");
    mkdirSync(join(root, "backups"), { recursive: true });
    mkdirSync(join(root, "restore"), { recursive: true });
    seedDb(source, "alpha");

    // When
    const copied = await backupSqlite({ sourcePath: source, destPath: backup });
    const sourceDb = new Database(source);
    sourceDb.prepare("UPDATE sentinel SET value=? WHERE id=?").run("mutated", "row-1");
    sourceDb.close();
    const recovered = restoreSqlite({ backupPath: backup, destPath: restored });
    const restoredDb = new Database(restored, { readonly: true, fileMustExist: true });
    const row = restoredDb.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1") as { readonly value: string };
    restoredDb.close();

    // Then
    expect(copied.quick_check).toBe("ok");
    expect(recovered.quick_check).toBe("ok");
    expect(copied.sha256).toBe(recovered.sha256);
    expect(row.value).toBe("alpha");
  });

  it("refuses production database paths and publishes a relative current symlink in an isolated root", async () => {
    // Given
    const root = scratch();
    const stage = join(root, "stage");
    mkdirSync(join(stage, "dist/src"), { recursive: true });
    writeFileSync(join(stage, "package.json"), "{}\n");
    writeFileSync(join(stage, "dist/src/cli.js"), "export {};\n");

    // When
    const published = publishRelease({
      stage,
      runtimeRoot: join(root, "authority"),
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    // Then
    expect(published.currentTarget).toBe("releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(readFileSync(join(root, "authority", "current", "dist/src/cli.js"), "utf8")).toBe("export {};\n");
    await expect(backupSqlite({
      sourcePath: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
      destPath: join(root, "x.sqlite"),
    })).rejects.toBeInstanceOf(PersonalOsError);
    expect(() => restoreSqlite({
      backupPath: join(root, "missing.sqlite"),
      destPath: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
    })).toThrow(PersonalOsError);
  });

  it("refuses a non-sqlite backup instead of copying it as recovered state", () => {
    const root = scratch();
    const junk = join(root, "junk.sqlite");
    const dest = join(root, "restore", "jarvis.sqlite");
    mkdirSync(join(root, "restore"), { recursive: true });
    writeFileSync(junk, "not-a-database");
    expect(() => restoreSqlite({ backupPath: junk, destPath: dest })).toThrow(PersonalOsError);
    expect(existsSync(dest)).toBe(false);
    expect(readFileSync(junk, "utf8")).toBe("not-a-database");
  });

  it("preserves an existing destination when the backup is missing or junk", () => {
    const root = scratch();
    const dest = join(root, "live.sqlite");
    const junk = join(root, "junk.sqlite");
    const missing = join(root, "missing.sqlite");
    seedDb(dest, "keep-existing-recovered-state");
    writeFileSync(junk, "not-a-database");
    const before = createHash("sha256").update(readFileSync(dest)).digest("hex");
    expect(() => restoreSqlite({ backupPath: missing, destPath: dest })).toThrow(PersonalOsError);
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(before);
    expect(() => restoreSqlite({ backupPath: junk, destPath: dest })).toThrow(PersonalOsError);
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(before);
    expect(readFileSync(junk, "utf8")).toBe("not-a-database");
    const live = new Database(dest, { readonly: true, fileMustExist: true });
    expect(live.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1")).toMatchObject({ value: "keep-existing-recovered-state" });
    live.close();
  });

  it("replaces an existing destination only after a validated backup and allows a corrected retry", () => {
    const root = scratch();
    const dest = join(root, "live.sqlite");
    const junk = join(root, "junk.sqlite");
    const good = join(root, "good.sqlite");
    seedDb(dest, "keep-existing-recovered-state");
    seedDb(good, "alpha");
    writeFileSync(junk, "not-a-database");
    const before = createHash("sha256").update(readFileSync(dest)).digest("hex");
    expect(() => restoreSqlite({ backupPath: junk, destPath: dest })).toThrow(PersonalOsError);
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(before);
    expect(() => restoreSqlite({ backupPath: dest, destPath: dest })).toThrow(PersonalOsError);
    expect(createHash("sha256").update(readFileSync(dest)).digest("hex")).toBe(before);
    const recovered = restoreSqlite({ backupPath: good, destPath: dest });
    expect(recovered.quick_check).toBe("ok");
    const live = new Database(dest, { readonly: true, fileMustExist: true });
    expect(live.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1")).toMatchObject({ value: "alpha" });
    live.close();
  });

  it("creates a missing dest without renaming over a path that is already occupied", () => {
    const root = scratch();
    const dest = join(root, "created.sqlite");
    const backup = join(root, "backup.sqlite");
    seedDb(backup, "backup-approved");
    const recovered = restoreSqlite({ backupPath: backup, destPath: dest });
    expect(recovered.quick_check).toBe("ok");
    const live = new Database(dest, { readonly: true, fileMustExist: true });
    expect(live.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1")).toMatchObject({ value: "backup-approved" });
    live.close();
  });

  it("refuses restore while another writer holds dest and keeps the writer commit", () => {
    const root = scratch();
    const dest = join(root, "live.sqlite");
    const backup = join(root, "good.sqlite");
    seedDb(dest, "writer-held");
    seedDb(backup, "backup-approved");
    const held = new Database(dest);
    held.exec("BEGIN IMMEDIATE");
    held.prepare("UPDATE sentinel SET value=? WHERE id=?").run("concurrent-writer-committed", "row-1");
    expect(() => restoreSqlite({ backupPath: backup, destPath: dest })).toThrow(PersonalOsError);
    held.exec("COMMIT");
    held.close();
    const live = new Database(dest, { readonly: true, fileMustExist: true });
    expect(live.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1")).toMatchObject({ value: "concurrent-writer-committed" });
    live.close();
  });

  it("reopens backup rows after replacing a dest that still has an orphan WAL", () => {
    const root = scratch();
    const backup = join(root, "backup.sqlite");
    const dest = join(root, "dest.sqlite");
    seedDb(backup, "backup-approved");
    const sqliteHref = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import Database from ${JSON.stringify(sqliteHref)};
const db=new Database(${JSON.stringify(dest)});
db.pragma("journal_mode=WAL");
db.pragma("wal_autocheckpoint=0");
db.exec("CREATE TABLE sentinel(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sentinel(id,value) VALUES('row-1','old-destination-unrecovered')");
process.exit(99);
`], { encoding: "utf8" });
    expect(child.status).toBe(99);
    expect(existsSync(`${dest}-wal`)).toBe(true);
    const recovered = restoreSqlite({ backupPath: backup, destPath: dest });
    expect(recovered.quick_check).toBe("ok");
    const live = new Database(dest, { readonly: true, fileMustExist: true });
    expect(live.prepare("SELECT value FROM sentinel WHERE id=?").get("row-1")).toMatchObject({ value: "backup-approved" });
    live.close();
  });
});
