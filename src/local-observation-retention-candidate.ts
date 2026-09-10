import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

/** Rewritten by the build itself, so these never match the source row for row. */
const REBUILT_TABLES = new Set(["schema_migrations", "memory_database_generations"]);
/** Columns the copy deliberately drops; the source side is projected the same way to compare. */
const DROPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  local_timeline_subjects: ["snapshot_json", "collection_id", "expires_at"],
};
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function serialize(row: unknown): string {
  const values = row !== null && typeof row === "object" ? Object.values(row) : [row];
  return createHash("sha256").update(values.map(value => {
    if (value === null) return "n:";
    if (Buffer.isBuffer(value)) return `b:${value.toString("base64")}`;
    if (typeof value === "number" || typeof value === "bigint") return `d:${value.toString()}`;
    return `s:${String(value)}`;
  }).join("\u0000")).digest("hex");
}

function columnsOf(database: AuthorityDb, table: string): readonly string[] {
  return database.db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const name = Reflect.get(value, "name");
    return typeof name === "string" && Reflect.get(value, "hidden") === 0 ? [name] : [];
  });
}

function projection(table: string, columns: readonly string[]): string {
  const dropped = new Set(DROPPED_COLUMNS[table] ?? []);
  return columns.map(column => dropped.has(column) ? `NULL AS ${quote(column)}` : quote(column)).join(",");
}

/**
 * Verifies that every row the candidate carries exists in the database the selection read.
 *
 * The rebuild adapter copies through its own `ATTACH` of the source pathname, so checking the
 * pathname's identity before and after the build brackets the copy without binding it: a pathname
 * replaced just before that attach and restored just after leaves both endpoint checks, this
 * connection's counters, and any row count agreeing with themselves. Row counts cannot help here
 * either - a replacement carrying equal counts and different rows satisfies every count.
 *
 * Comparing the copied rows themselves against the connection the selection used removes the
 * question of which file was attached: whatever the adapter read, the candidate may only contain
 * rows this connection also holds. A retention selection removes rows, so the candidate is
 * expected to be a subset; a row the source does not hold is
 * `LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW`. Tables the build rewrites are excluded by name, and
 * the columns the copy blanks are blanked on the source side too, so only genuine differences
 * remain.
 */
export function assertCandidateRowsCameFromSelection(source: AuthorityDb, destination: string): void {
  const candidate = new AuthorityDb(destination, undefined, { readonly: true, fileMustExist: true });
  let foreign: string | undefined;
  try {
    const tables = candidate.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).pluck().all().map(String).filter(table => !REBUILT_TABLES.has(table));
    for (const table of tables) {
      const columns = columnsOf(candidate, table);
      if (columns.length === 0) continue;
      const held = new Map<string, number>();
      for (const row of source.db.prepare(
        `SELECT ${projection(table, columns)} FROM ${quote(table)}`).iterate()) {
        const key = serialize(row);
        held.set(key, (held.get(key) ?? 0) + 1);
      }
      for (const row of candidate.db.prepare(
        `SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).iterate()) {
        const key = serialize(row);
        const remaining = held.get(key);
        if (remaining === undefined || remaining === 0) { foreign = table; break; }
        held.set(key, remaining - 1);
      }
      if (foreign !== undefined) break;
    }
  } finally {
    candidate.close();
    // The read-only open recreates the sidecars the build removed; they are this call's own.
    for (const suffix of SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  }
  if (foreign !== undefined) throw new JarvisError("LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW");
}
