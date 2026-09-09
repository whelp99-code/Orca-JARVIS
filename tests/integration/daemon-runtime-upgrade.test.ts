import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";

it("adds daemon072 after memory071 without changing prior schema, journal or reference attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-upgrade-"));
  const directory = join(root, "migrations"); mkdirSync(directory);
  const source = join(process.cwd(), "migrations");
  const daemonFile = "072_daemon_runtime_identity.sql";
  const prior = readdirSync(source).filter(file => file.endsWith(".sql") && file < daemonFile);
  expect(prior).toHaveLength(72);
  expect(prior).toContain("028_budgeted_evolution_memory.sql");
  for (const file of prior) copyFileSync(join(source, file), join(directory, file));
  const db = new AuthorityDb(join(root, "authority.sqlite"), directory);
  try {
    await db.migrate();
    const journal = () => db.db.prepare("SELECT * FROM schema_migrations ORDER BY id").all();
    const schema = () => db.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const before = journal(); const objects = schema();
    const key = `hmac-sha256:${"a".repeat(64)}`; const at = "2026-09-08T00:00:00.000Z";
    db.db.prepare("INSERT INTO personal_context_reference_identity VALUES(1,?)").run(key);
    db.db.prepare("INSERT INTO personal_context_reference_sessions VALUES(?,?,?,?,?)").run(key, key, "active", at, at);
    db.db.prepare("INSERT INTO personal_context_reference_attempts VALUES(?,?,?,?,?,?,?,?)")
      .run("fixture:attempt", key, key, key, key, "dispatching", at, at);
    const attempts = () => db.db.prepare("SELECT * FROM personal_context_reference_attempts").all();
    const original = attempts();
    copyFileSync(join(source, daemonFile), join(directory, daemonFile));
    await db.migrate(); await db.migrate(); await db.assertMigrationsReady();
    const after = journal();
    expect(after).toHaveLength(before.length + 1); expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toMatchObject({ id: daemonFile,
      checksum: createHash("sha256").update(readFileSync(join(source, daemonFile))).digest("hex") });
    expect(attempts()).toEqual(original);
    expect(schema().filter(value => (value as { name: string }).name !== "gjc_runtime_identity")).toEqual(objects);
    expect(db.db.pragma("quick_check", { simple: true })).toBe("ok");
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
