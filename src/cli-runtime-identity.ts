import Database from "better-sqlite3";
import { createRuntimeIdentityReader } from "./runtime-identity.js";
import { readDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";

/** Diagnose even unmigrated/missing DBs without AuthorityDb initialization or migration. */
export function inspectRuntimeIdentity(filename: string | undefined, now: Date): Record<string, unknown> {
  let db: Database.Database | null = null;
  try {
    try { db = new Database(filename ?? process.env.JARVIS_DB ?? "jarvis-authority.sqlite", { readonly: true, fileMustExist: true }); }
    catch { /* Missing/unreadable DB remains explicit unavailable evidence. */ }
    return { ok: true, command: "runtime.identity", observer: createRuntimeIdentityReader(db)(now),
      daemon: readDaemonRuntimeIdentity(db, now) };
  } finally { db?.close(); }
}
