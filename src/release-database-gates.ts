import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationVectorHash } from "./backend-build-files.js";
import { readCycleCursor } from "./personal-os-cycle-channel.js";
import { applyCycleId } from "./personal-os-cycle-cursor.js";
import { type ReleaseGate, gate, hasTable, readOnly } from "./release-gate-contract.js";

function migrationDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

export type MigrationEntryObservation = { readonly id: string; readonly sha256: string };

export async function shippedMigrationEntries(
  directory = migrationDirectory(),
): Promise<readonly MigrationEntryObservation[]> {
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async id => ({
    id,
    sha256: createHash("sha256").update(await readFile(join(directory, id))).digest("hex"),
  })));
}

/** PRAGMA quick_check on a read-only open; anything but `ok` fails the gate. */
export function quickCheckGate(dbPath: string): ReleaseGate {
  try {
    const value = readOnly(dbPath, db => db.pragma("quick_check", { simple: true }));
    const check = typeof value === "string" ? value : "fail";
    return gate("quick-check", check === "ok", { quick_check: check },
      check === "ok" ? undefined : "DATABASE_INTEGRITY_FAILED");
  } catch {
    return gate("quick-check", false, { quick_check: "unavailable" }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** PRAGMA foreign_key_check on a read-only open; any returned row fails the gate. */
export function foreignKeyCheckGate(dbPath: string): ReleaseGate {
  try {
    const rows = readOnly(dbPath, db => db.prepare("PRAGMA foreign_key_check").all() as unknown[]);
    return gate("foreign-key-check", rows.length === 0,
      { violations: rows.length, first_violations: rows.slice(0, 8) },
      rows.length === 0 ? undefined : "DATABASE_FOREIGN_KEY_VIOLATION");
  } catch {
    return gate("foreign-key-check", false, { violations: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** The exact applied migration vector, compared entry by entry against the shipped migrations. */
export async function migrationVectorGate(dbPath: string): Promise<ReleaseGate> {
  let expected: readonly MigrationEntryObservation[];
  try {
    expected = await shippedMigrationEntries();
  } catch {
    return gate("migration-vector", false, { expected: null }, "RELEASE_GATE_MIGRATIONS_UNREADABLE");
  }
  try {
    const applied = readOnly(dbPath, db => hasTable(db, "schema_migrations")
      ? db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id").all() as MigrationEntryObservation[]
      : []);
    const appliedById = new Map(applied.map(entry => [entry.id, entry.sha256]));
    const pending = expected.filter(entry => !appliedById.has(entry.id)).map(entry => entry.id);
    const mismatched = expected
      .filter(entry => appliedById.has(entry.id) && appliedById.get(entry.id) !== entry.sha256)
      .map(entry => entry.id);
    const expectedIds = new Set(expected.map(entry => entry.id));
    const unknown = applied.filter(entry => !expectedIds.has(entry.id)).map(entry => entry.id);
    const ok = pending.length === 0 && mismatched.length === 0 && unknown.length === 0;
    return gate("migration-vector", ok, {
      expected_digest: migrationVectorHash(expected),
      applied_digest: migrationVectorHash(applied),
      expected_migrations: expected.length,
      applied_migrations: applied.length,
      pending_migrations: pending,
      checksum_mismatched: mismatched,
      unsupported_applied: unknown,
    }, ok ? undefined
      : mismatched.length > 0 ? "MIGRATION_CHECKSUM_MISMATCH"
      : unknown.length > 0 ? "MIGRATION_VERSION_UNSUPPORTED"
      : "MIGRATIONS_PENDING");
  } catch {
    return gate("migration-vector", false, { applied: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** Queued memory writes whose delivery is unresolved; activation may not run over an uncertain outbox. */
export function uncertainOutboxGate(dbPath: string): ReleaseGate {
  try {
    const counts = readOnly(dbPath, db => {
      const count = (table: string): number => hasTable(db, table)
        ? Number(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE state='uncertain'`).pluck().get())
        : 0;
      return { memory_outbox: count("memory_outbox"), daily_loop_runs: count("daily_loop_runs") };
    });
    const total = counts.memory_outbox + counts.daily_loop_runs;
    return gate("uncertain-outbox", total === 0, { uncertain: total, ...counts },
      total === 0 ? undefined : "RELEASE_GATE_UNCERTAIN_OUTBOX");
  } catch {
    return gate("uncertain-outbox", false, { uncertain: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

function nextCycleId(lastCompleted: number): number | null {
  const result = applyCycleId(lastCompleted, lastCompleted + 1);
  return result.kind === "applied" ? result.id : null;
}

/**
 * The persisted personal-OS cycle cursor and its consistency with daily_loop_runs. The channel
 * advances last_completed and applied_count together from zero, so they must be equal, and the
 * cursor may never sit behind the completed daily loop runs it accounts for.
 */
export function schedulerCursorGate(dbPath: string): ReleaseGate {
  try {
    return readOnly(dbPath, db => {
      if (!hasTable(db, "personal_os_cycle_cursor")) {
        return gate("scheduler-cursor", false, { cursor: null }, "RELEASE_GATE_SCHEDULER_CURSOR_ABSENT");
      }
      const cursor = readCycleCursor(db);
      const completed = hasTable(db, "daily_loop_runs")
        ? Number(db.prepare("SELECT COUNT(*) FROM daily_loop_runs WHERE state='completed'").pluck().get())
        : 0;
      const monotonic = cursor.applied_count === cursor.last_completed;
      const notBehind = cursor.last_completed >= completed;
      const ok = monotonic && notBehind;
      return gate("scheduler-cursor", ok, {
        last_completed: cursor.last_completed,
        applied_count: cursor.applied_count,
        next_cycle_id: nextCycleId(cursor.last_completed),
        completed_daily_loop_runs: completed,
        cursor_monotonic: monotonic,
        not_behind_daily_loop: notBehind,
      }, ok ? undefined : "RELEASE_GATE_SCHEDULER_CURSOR_INCONSISTENT");
    });
  } catch {
    return gate("scheduler-cursor", false, { cursor: null }, "RELEASE_GATE_SCHEDULER_CURSOR_UNREADABLE");
  }
}
