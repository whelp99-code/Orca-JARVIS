import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/cli-runtime.mjs";
import { AuthorityDb } from "../../src/db.js";

const SHIPPED = fileURLToPath(new URL("../../migrations/", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-rehearse-"));
  roots.push(root);
  return root;
}

function shippedMigrations(): readonly string[] {
  return readdirSync(SHIPPED).filter(name => name.endsWith(".sql")).sort();
}

/** A fixture authority database left at an older migration level than the shipped migrations. */
async function databaseAtLevel(count: number): Promise<{ readonly path: string; readonly applied: number }> {
  const root = scratch();
  const partial = join(root, "migrations");
  mkdirSync(partial, { recursive: true });
  const selected = shippedMigrations().slice(0, count);
  for (const name of selected) copyFileSync(join(SHIPPED, name), join(partial, name));
  const path = join(root, "old-authority.sqlite");
  const db = new AuthorityDb(path, partial);
  try {
    await db.migrate();
  } finally {
    db.close();
  }
  return { path, applied: selected.length };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("db migrate --rehearse", () => {
  it("applies the pending migrations to a copy, gates it, and never touches the source", async () => {
    const fixture = await databaseAtLevel(30);
    const shipped = shippedMigrations().length;
    const before = { sha256: digest(fixture.path), bytes: lstatSync(fixture.path).size,
      mtime: lstatSync(fixture.path).mtimeMs };
    const scratchSiblings = readdirSync(join(fixture.path, "..")).sort();

    const result = await execute(["db", "migrate", "--rehearse", fixture.path]);
    expect(result).toMatchObject({
      ok: true,
      command: "db.migrate.rehearse",
      applied_before: fixture.applied,
      applied_after: shipped,
      pending_before: shipped - fixture.applied,
      failed: [],
      source: { path: fixture.path, sha256: before.sha256, bytes: before.bytes, untouched: true },
    });
    expect(result["exit_code"]).toBeUndefined();
    const applied = result["applied_migrations"] as string[];
    expect(applied).toHaveLength(shipped - fixture.applied);
    expect(applied.length).toBeGreaterThan(40);
    expect(applied).toEqual(shippedMigrations().slice(fixture.applied));
    const gates = result["gates"] as Array<{ name: string; ok: boolean }>;
    expect(gates.map(gate => gate.name)).toEqual(["quick-check", "foreign-key-check", "migration-vector"]);
    expect(gates.every(gate => gate.ok)).toBe(true);

    // The source database is still at its old level, byte for byte, with no new sidecars beside it.
    expect(digest(fixture.path)).toBe(before.sha256);
    expect(lstatSync(fixture.path).mtimeMs).toBe(before.mtime);
    expect(readdirSync(join(fixture.path, "..")).sort()).toEqual(scratchSiblings);
    const source = new AuthorityDb(fixture.path, undefined, { fileMustExist: true, readonly: true });
    try {
      expect(source.db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(fixture.applied);
      await expect(source.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" });
    } finally {
      source.close();
    }
  }, 120_000);

  it("leaves no scratch copy behind", async () => {
    const fixture = await databaseAtLevel(30);
    const parent = scratch();
    const before = readdirSync(parent);
    process.env["TMPDIR"] = parent;
    try {
      await execute(["db", "migrate", "--rehearse", fixture.path]);
    } finally {
      delete process.env["TMPDIR"];
    }
    expect(readdirSync(parent)).toEqual(before);
  }, 120_000);

  it("refuses a missing source and a rehearsal attached to any other command", async () => {
    await expect(execute(["db", "migrate", "--rehearse", join(scratch(), "absent.sqlite")]))
      .rejects.toMatchObject({ code: "MIGRATION_REHEARSAL_SOURCE_UNAVAILABLE" });
    await expect(execute(["db", "migrate", "--rehearse", join(scratch(), "x.sqlite"), "--db", "unused.sqlite"]))
      .rejects.toMatchObject({ code: "MIGRATION_REHEARSAL_INPUT_INVALID" });
    await expect(execute(["doctor", "--rehearse", "x.sqlite"]))
      .rejects.toMatchObject({ code: "MIGRATION_REHEARSAL_INPUT_INVALID" });
    expect(existsSync("unused.sqlite")).toBe(false);
  });
});
