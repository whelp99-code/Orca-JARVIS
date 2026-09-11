import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  });
});
