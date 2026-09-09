import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { externalAnchors } from "../helpers.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";

it("clones the actual schema while keeping data, trust anchors and policy keys independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "schema-fixture-isolation-"));
  const databases: AuthorityDb[] = [];
  try {
    const fresh = new AuthorityDb(join(root, "fresh.sqlite")); databases.push(fresh); await fresh.migrate();
    const clones = await Promise.all(["a", "b"].map(name => migratedTestDatabase(join(root, name + ".sqlite"))));
    databases.push(...clones);
    for (const db of clones) {
      expect(db.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all())
        .toEqual(fresh.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
      expect(db.db.prepare("SELECT id,checksum FROM schema_migrations ORDER BY id").all())
        .toEqual(fresh.db.prepare("SELECT id,checksum FROM schema_migrations ORDER BY id").all());
      expect(db.db.prepare("SELECT count(*) AS n FROM trusted_authority_keys").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT count(*) AS n FROM authority_configuration").get()).toEqual({ n: 0 });
      expect(existsSync(db.filename + ".policy-key.pem")).toBe(false);
      const anchors = externalAnchors();
      await db.initialize({ decision: { keyId: "d", principal: "owner", publicKeyPath: anchors.decisionPublic },
        verifier: { keyId: "v", principal: "reviewer", publicKeyPath: anchors.verifierPublic } });
      rmSync(join(anchors.decisionPublic, ".."), { recursive: true, force: true });
    }
    const [a, b] = clones as [AuthorityDb, AuthorityDb];
    expect(a.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='d'").get())
      .not.toEqual(b.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='d'").get());
    expect(readFileSync(a.filename + ".policy-key.pem", "utf8")).not.toBe(readFileSync(b.filename + ".policy-key.pem", "utf8"));
    a.db.exec("CREATE TABLE fixture_mutation(value TEXT); INSERT INTO fixture_mutation VALUES('private')");
    expect(b.db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_mutation'").get()).toBeUndefined();
    const c = await migratedTestDatabase(join(root, "c.sqlite")); databases.push(c);
    expect(c.db.prepare("SELECT name FROM sqlite_master WHERE name='fixture_mutation'").get()).toBeUndefined();
    expect(c.db.prepare("SELECT count(*) AS n FROM trusted_authority_keys").get()).toEqual({ n: 0 });
    for (const db of databases) expect(db.db.pragma("quick_check", { simple: true })).toBe("ok");
  } finally { for (const db of databases) db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("invalidates on migration bytes and retains normal checksum rejection on an older clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "schema-fixture-version-")), migrations = join(root, "migrations");
  const databases: AuthorityDb[] = [];
  try {
    cpSync("migrations", migrations, { recursive: true });
    const extra = join(migrations, "999_fixture.sql");
    writeFileSync(extra, "CREATE TABLE original_fixture(value TEXT);");
    const a = await migratedTestDatabase(join(root, "a.sqlite"), migrations); databases.push(a);
    writeFileSync(extra, "CREATE TABLE changed_fixture(value TEXT);");
    const b = await migratedTestDatabase(join(root, "b.sqlite"), migrations); databases.push(b);
    expect(b.db.prepare("SELECT name FROM sqlite_master WHERE name='changed_fixture'").get()).toBeDefined();
    expect(b.db.prepare("SELECT name FROM sqlite_master WHERE name='original_fixture'").get()).toBeUndefined();
    await expect(a.migrate()).rejects.toThrow("999_fixture.sql");
    expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name='original_fixture'").get()).toBeDefined();
  } finally { for (const db of databases) db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("never overwrites an existing fixture destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "schema-fixture-existing-")), path = join(root, "existing");
  try {
    writeFileSync(path, "preserve");
    await expect(migratedTestDatabase(path)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("preserve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
