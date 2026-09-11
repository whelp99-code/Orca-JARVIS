import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import type { RetentionProjection } from "./local-observation-retention-selection.js";

/** Rewritten by the build itself, so these are checked against their own contract instead. */
const REBUILT_TABLES = new Set(["schema_migrations", "memory_database_generations"]);
/** Columns the copy deliberately drops; the source side is projected the same way to compare. */
const DROPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  local_timeline_subjects: ["snapshot_json", "collection_id", "expires_at"],
};
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function values(row: unknown): readonly unknown[] {
  return row !== null && typeof row === "object" ? Object.values(row) : [row];
}

function serialize(row: unknown): string {
  return createHash("sha256").update(values(row).map(value => {
    if (value === null) return "n:";
    if (Buffer.isBuffer(value)) return `b:${value.toString("base64")}`;
    if (typeof value === "number" || typeof value === "bigint") return `d:${value.toString()}`;
    return `s:${String(value)}`;
  }).join(" ")).digest("hex");
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

const scalar = (database: AuthorityDb, sql: string): number =>
  Number(database.db.prepare(sql).pluck().get());

/**
 * Checks the two tables the build rewrites against their own contract, so excluding them from the
 * row comparison is not a blanket permission to differ.
 */
function assertRebuiltTables(source: AuthorityDb, candidate: AuthorityDb, generation: number): void {
  const migrations = "SELECT COUNT(*) FROM schema_migrations";
  const active = "SELECT COUNT(*) FROM memory_database_generations WHERE state='active' AND generation=";
  if (scalar(candidate, migrations) !== scalar(source, migrations)
    || scalar(candidate, `${active}${generation}`) !== 1) {
    throw new JarvisError("LOCAL_RETENTION_CANDIDATE_REBUILD_INVALID");
  }
}

/**
 * Verifies that the candidate is the database the selection read minus exactly what the selection
 * chose to remove.
 *
 * The rebuild adapter copies through its own `ATTACH` of the source pathname, so checks that only
 * bracket the build cannot bind it: a pathname replaced just before that attach and restored just
 * after leaves the endpoints, this connection's counters and every row count agreeing with
 * themselves. Row counts cannot help either, since a replacement carrying equal counts and
 * different rows satisfies them all.
 *
 * Comparing the copied rows against the connection the selection used settles what was copied
 * rather than which file was attached, and it has to run in both directions. A row the connection
 * does not hold is `LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW`. A row the connection holds and the
 * candidate lost is allowed only when the selection blocked it - every row this rebuild may drop
 * names a blocked observation, context or recommendation in one of its columns - and is otherwise
 * `LOCAL_RETENTION_CANDIDATE_MISSING_ROW`. Without that second direction a substituted source that
 * merely lacks unrelated rows passes as a subset.
 */
export function assertCandidateMatchesSelectedRemoval(
  source: AuthorityDb, destination: string,
  blocked: readonly RetentionProjection[], resultGeneration: number,
): void {
  const removable = new Set(blocked.map(item => item.id));
  const candidate = new AuthorityDb(destination, undefined, { readonly: true, fileMustExist: true });
  let failure: string | undefined;
  try {
    assertRebuiltTables(source, candidate, resultGeneration);
    const tables = candidate.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).pluck().all().map(String).filter(table => !REBUILT_TABLES.has(table));
    for (const table of tables) {
      const columns = columnsOf(candidate, table);
      if (columns.length === 0) continue;
      const held = new Map<string, { count: number; readonly row: readonly unknown[] }>();
      for (const row of source.db.prepare(
        `SELECT ${projection(table, columns)} FROM ${quote(table)}`).iterate()) {
        const key = serialize(row);
        const entry = held.get(key);
        if (entry === undefined) held.set(key, { count: 1, row: values(row) });
        else entry.count += 1;
      }
      for (const row of candidate.db.prepare(
        `SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).iterate()) {
        const entry = held.get(serialize(row));
        if (entry === undefined || entry.count === 0) {
          failure = "LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW";
          break;
        }
        entry.count -= 1;
      }
      if (failure !== undefined) break;
      // Whatever the candidate did not take must be a row this selection chose to remove.
      for (const entry of held.values()) {
        if (entry.count === 0) continue;
        if (!entry.row.some(value => typeof value === "string" && removable.has(value))) {
          failure = "LOCAL_RETENTION_CANDIDATE_MISSING_ROW";
          break;
        }
      }
      if (failure !== undefined) break;
    }
  } finally {
    candidate.close();
    // The read-only open recreates the sidecars the build removed; they are this call's own.
    for (const suffix of SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  }
  if (failure !== undefined) throw new JarvisError(failure);
}
