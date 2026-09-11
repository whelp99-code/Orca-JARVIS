import Database from "better-sqlite3";
import { assertSwapAdmission } from "./authority-database-swap-barrier.js";
import { createRuntimeIdentityReader } from "./runtime-identity.js";
import { readDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";

/** Diagnose even unmigrated/missing DBs without AuthorityDb initialization or migration. */
export function inspectRuntimeIdentity(filename: string | undefined, now: Date): Record<string, unknown> {
  let db: Database.Database | null = null;
  try {
    const path = filename ?? process.env.JARVIS_DB ?? "jarvis-authority.sqlite";
    // This is the one reader that opens the authority file without going through AuthorityDb, so
    // it asks the same question that constructor asks. A descriptor taken here during a swap would
    // make the swap refuse; a diagnostic must not be the reason a replacement cannot proceed, and
    // reporting the database as unavailable for the moment it is being replaced is the truth.
    try { assertSwapAdmission(path); db = new Database(path, { readonly: true, fileMustExist: true }); }
    catch { /* Missing, unreadable or mid-swap DB remains explicit unavailable evidence. */ }
    return { ok: true, command: "runtime.identity", observer: createRuntimeIdentityReader(db)(now),
      daemon: readDaemonRuntimeIdentity(db, now) };
  } finally { db?.close(); }
}
