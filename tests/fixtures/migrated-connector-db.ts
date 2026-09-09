import type { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import { migratedTestDatabase } from "./migrated-database.js";

/** Only connector fixtures opt in. Migration and production initialization paths stay independent. */
export async function migratedConnectorDb(): Promise<AuthorityDb> {
  const db = await migratedTestDatabase(tempDb());
  try { await db.assertMigrationsReady(); return db; }
  catch (error) { db.close(); throw error; }
}
