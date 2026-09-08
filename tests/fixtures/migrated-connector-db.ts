import { writeFileSync } from "node:fs";
import { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";

// This module-local image contains only migration defaults, never fixture writes or keys.
let image: Promise<Buffer> | undefined;
async function schemaImage(): Promise<Buffer> {
  const seed = new AuthorityDb(":memory:");
  try { await seed.migrate(); return seed.db.serialize(); }
  finally { seed.close(); }
}

/** Only connector fixtures opt in. Migration and production initialization paths stay independent. */
export async function migratedConnectorDb(): Promise<AuthorityDb> {
  image ??= schemaImage().catch(error => { image = undefined; throw error; });
  const bytes = await image;
  const filename = tempDb();
  writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
  const db = new AuthorityDb(filename);
  try { await db.assertMigrationsReady(); return db; }
  catch (error) { db.close(); throw error; }
}
