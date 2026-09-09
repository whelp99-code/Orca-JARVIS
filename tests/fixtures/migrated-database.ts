import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../src/db.js";

const defaultMigrations = fileURLToPath(new URL("../../migrations/", import.meta.url));
let cached: { key: string; bytes: Promise<Buffer> } | undefined;

function identity(directory: string): string {
  const hash = createHash("sha256").update(directory).update("\0");
  for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
    const bytes = readFileSync(join(directory, name));
    hash.update(JSON.stringify([name, bytes.length])).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

async function template(directory: string, key: string): Promise<Buffer> {
  const db = new AuthorityDb(":memory:", directory);
  try {
    await db.migrate();
    if (identity(directory) !== key) throw new Error("TEST_SCHEMA_CHANGED");
    return db.db.serialize();
  } finally {
    db.close();
  }
}

/** Test fixture only: cache migrated, uninitialized schema, never keys or test data.
 * Migration/upgrade tests must continue constructing AuthorityDb directly. */
export async function migratedTestDatabase(path: string, migrations = defaultMigrations): Promise<AuthorityDb> {
  const directory = resolve(migrations), key = identity(directory);
  if (cached?.key !== key) cached = { key, bytes: template(directory, key) };
  const selected = cached;
  let bytes: Buffer;
  try { bytes = await selected.bytes; }
  catch (error) { if (cached === selected) cached = undefined; throw error; }
  if (identity(directory) !== key) throw new Error("TEST_SCHEMA_CHANGED");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return new AuthorityDb(path, directory);
}
