import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { copyExpression, copyFilter, tableColumns } from "./memory-authority-fresh-builder.js";
import {
  suppressedRowMutations, type SuppressedProjection,
} from "./memory-compaction-sanitize.js";

const SIDECARS = ["-wal", "-shm", "-journal"] as const;
/**
 * The fresh database applies its own migrations, so its `applied_at` is its own. The identity that
 * must match is the applied set and each checksum; nothing else about this table is excused.
 */
const SELF_APPLIED = "schema_migrations";
const SELF_APPLIED_IDENTITY = ["id", "checksum"] as const;
const GENERATIONS = "memory_database_generations";

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * Typed, length-prefixed row key. Values keep their SQL type tag and their exact bytes, and every
 * value carries its own length, so no two different rows - differing in separators, quotes, empty
 * strings, NULLs, blobs or numeric type - can produce the same key.
 */
function rowKey(row: unknown): string {
  const values = row !== null && typeof row === "object" ? Object.values(row) : [row];
  const hash = createHash("sha256");
  for (const value of values) {
    const [tag, encoded] = value === null ? ["n", ""]
      : Buffer.isBuffer(value) ? ["b", value.toString("base64")]
      : typeof value === "bigint" ? ["i", value.toString()]
      // Every comparison reads with exact integers, so a SQLite INTEGER arrives as a bigint and a
      // number is always a REAL. Tagging an integral REAL as an integer would let 1.0 and 1 share
      // a key, which SQLite treats as different values.
      : typeof value === "number" ? ["f", value.toString()]
      : ["s", String(value)];
    hash.update(`${tag}${Buffer.byteLength(String(encoded), "utf8")}:${encoded}\u0000`);
  }
  return hash.digest("hex");
}

/**
 * Reads comparison rows with exact integers.
 *
 * Without this, SQLite integers arrive as JavaScript numbers and two different values above
 * 2^53 round to the same one, so a candidate could differ from the source in an INTEGER column and
 * still produce an identical row key. Both sides of every comparison read through here.
 */
function exact(database: AuthorityDb, sql: string): Database.Statement {
  return database.db.prepare(sql).safeIntegers(true);
}

function tablesOf(database: AuthorityDb): readonly string[] {
  return database.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).pluck().all().map(String);
}

function multiset(rows: Iterable<unknown>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
  return counts;
}

/**
 * The copier evaluates its keep filter against a temporary `blocked_projections` table and against
 * the source attached as `source_authority`. The verifier reproduces both names on its own
 * connection rather than reinterpreting the predicate: the same file is attached under that name,
 * so every filter the copier runs resolves to the same rows here.
 */
function withBlockedProjections<T>(
  snapshot: AuthorityDb, blocked: readonly SuppressedProjection[], read: () => T,
): T {
  snapshot.db.exec("CREATE TEMP TABLE blocked_projections(kind TEXT,id TEXT,component_id TEXT)");
  snapshot.db.prepare("ATTACH DATABASE ? AS source_authority").run(snapshot.filename);
  try {
    const insert = snapshot.db.prepare(
      "INSERT INTO blocked_projections(kind,id,component_id) VALUES(?,?,?)");
    for (const projection of blocked) {
      insert.run(projection.kind, projection.id, projection.component_id);
    }
    return read();
  } finally {
    snapshot.db.exec("DETACH DATABASE source_authority");
    snapshot.db.exec("DROP TABLE IF EXISTS blocked_projections");
  }
}

/** The rows the copier keeps for this table, with the sanitizer's removals already applied. */
function expectedRows(
  snapshot: AuthorityDb, table: string, columns: readonly string[],
  blocked: readonly SuppressedProjection[],
): Map<string, number> {
  const selected = columns.map(column => `${copyExpression(table, column)} AS ${quote(column)}`).join(",");
  const kept = multiset(exact(snapshot,
    `SELECT ${selected} FROM ${quote(table)} AS source_row ${copyFilter(table, columns)}`).iterate());
  for (const projection of blocked) {
    for (const mutation of suppressedRowMutations(projection)) {
      if (mutation.table !== table) continue;
      if (mutation.update !== undefined) throw new JarvisError("LOCAL_RETENTION_PLAN_UNSUPPORTED");
      for (const row of exact(snapshot,
        `SELECT ${selected} FROM ${quote(table)} AS source_row WHERE ${mutation.where}`)
        .iterate(...mutation.params)) {
        const key = rowKey(row);
        const remaining = kept.get(key);
        if (remaining !== undefined && remaining > 0) kept.set(key, remaining - 1);
      }
    }
  }
  return kept;
}

/** The generation table is the one the build rewrites: retire the active row, add the next one. */
type GenerationRow = { readonly generation: bigint; readonly digest: string; readonly state: string };

function assertGenerations(snapshot: AuthorityDb, candidate: AuthorityDb, resultGeneration: number): void {
  // Typed and exact, like every other comparison here: JSON numbers round past the safe range, so
  // two different histories could serialize identically.
  const rows = (database: AuthorityDb): readonly GenerationRow[] => exact(database,
    `SELECT generation,database_manifest_digest AS digest,state FROM ${GENERATIONS} ORDER BY generation`)
    .all().map(value => {
      const row = value as Record<string, unknown>;
      if (typeof row["generation"] !== "bigint" || typeof row["digest"] !== "string"
        || typeof row["state"] !== "string") {
        throw new JarvisError("LOCAL_RETENTION_CANDIDATE_GENERATION_INVALID");
      }
      return { generation: row["generation"], digest: row["digest"], state: row["state"] };
    });
  const key = (row: GenerationRow): string => `${row.generation}\u0000${row.digest}\u0000${row.state}`;
  // The build retires the row that was active and adds the next one. Nothing else may move.
  const before = rows(snapshot)
    .map(row => key(row.state === "active" ? { ...row, state: "retired" } : row));
  const after = rows(candidate);
  const present = after.map(key);
  const added = after.filter(row => !before.includes(key(row)));
  if (after.length !== before.length + 1 || before.some(row => !present.includes(row))
    || added.length !== 1 || added[0]?.generation !== BigInt(resultGeneration)
    || added[0]?.state !== "active") {
    throw new JarvisError("LOCAL_RETENTION_CANDIDATE_GENERATION_INVALID");
  }
}

/**
 * Verifies that the candidate is exactly what the copier's own plan produces from the snapshot the
 * selection read.
 *
 * The plan is not restated here: the per-table keep filter comes from `copyFilter`, the column
 * transforms from `copyExpression`, and the removals from `suppressedRowMutations`, which are the
 * same functions the rebuild adapter and its sanitizer run. Earlier versions approximated that
 * plan - counting rows, then allowing any row that mentioned a blocked identifier - and each
 * approximation accepted a wrong candidate: a replacement with equal counts, and the removal of an
 * audit row whose subject happened to be a blocked context, which the copier deliberately keeps.
 *
 * Both directions are checked against the expected multiset, so an extra row, a missing row, a
 * changed value and a lost duplicate are all rejected, as is a table or column set that differs.
 */
export function assertCandidateMatchesCopyPlan(
  snapshot: AuthorityDb, destination: string,
  blocked: readonly SuppressedProjection[], resultGeneration: number,
): void {
  const candidate = new AuthorityDb(destination, undefined, { readonly: true, fileMustExist: true });
  let failure: string | undefined;
  let failedTable = "";
  try {
    withBlockedProjections(snapshot, blocked, () => {
    const tables = tablesOf(snapshot);
    if (JSON.stringify(tables) !== JSON.stringify(tablesOf(candidate))) {
      throw new JarvisError("LOCAL_RETENTION_CANDIDATE_SCHEMA_INVALID");
    }
    assertGenerations(snapshot, candidate, resultGeneration);
    for (const table of tables) {
      if (table === GENERATIONS) continue;
      const columns = tableColumns(snapshot, table);
      if (JSON.stringify(columns) !== JSON.stringify(tableColumns(candidate, table))) {
        failure = "LOCAL_RETENTION_CANDIDATE_SCHEMA_INVALID";
        break;
      }
      if (columns.length === 0) continue;
      const list = (table === SELF_APPLIED ? SELF_APPLIED_IDENTITY : columns).map(quote).join(",");
      const expected = table === SELF_APPLIED
        ? multiset(exact(snapshot, `SELECT ${list} FROM ${quote(table)}`).iterate())
        : expectedRows(snapshot, table, columns, blocked);
      for (const row of exact(candidate, `SELECT ${list} FROM ${quote(table)}`).iterate()) {
        const key = rowKey(row);
        const remaining = expected.get(key);
        if (remaining === undefined || remaining === 0) {
          failure = "LOCAL_RETENTION_CANDIDATE_FOREIGN_ROW";
          failedTable = table;
          break;
        }
        expected.set(key, remaining - 1);
      }
      if (failure === undefined && [...expected.values()].some(count => count > 0)) {
        failure = "LOCAL_RETENTION_CANDIDATE_MISSING_ROW";
        failedTable = table;
      }
      if (failure !== undefined) break;
    }
    });
  } finally {
    candidate.close();
    // The read-only open recreates the sidecars the build removed; they are this call's own.
    for (const suffix of SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  }
  if (failure !== undefined) throw new JarvisError(failure, `${failure} at ${failedTable}`);
}
