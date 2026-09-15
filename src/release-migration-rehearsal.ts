import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { migrationVectorHash } from "./backend-build-files.js";
import { AuthorityDb, JarvisError } from "./db.js";
import {
  foreignKeyCheckGate,
  migrationVectorGate,
  quickCheckGate,
  type ReleaseGate,
} from "./release-health-gates.js";

/** A byte-wise copy needs the write-ahead files beside the database to recover the same state. */
const SIDECARS = ["-wal", "-shm"] as const;

export type SourceObservation = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mtime_ms: number;
  readonly sidecars: readonly string[];
};

export type MigrationRehearsalChecks = {
  readonly quick_check: string | null;
  readonly foreign_key_violations: number | null;
  readonly migration_vector_ok: boolean;
};

export type MigrationRehearsalResult = {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly source: SourceObservation & { readonly untouched: true };
  /** The applied vector the source database is on right now: what a pre-activation gate matches. */
  readonly source_vector_digest: string;
  /** The applied vector the rehearsed migration landed on: the release's own shipped vector. */
  readonly target_vector_digest: string;
  readonly applied_migrations: readonly string[];
  readonly pending_before: number;
  readonly applied_before: number;
  readonly applied_after: number;
  readonly checks: MigrationRehearsalChecks;
  readonly gates: readonly ReleaseGate[];
  readonly failed: readonly string[];
  /** Where the receipt was written, when one was asked for. */
  readonly receipt?: string;
};

export const MIGRATION_REHEARSAL_RECEIPT_KIND = "migration-rehearsal" as const;

function observe(path: string): SourceObservation {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new JarvisError("MIGRATION_REHEARSAL_SOURCE_UNAVAILABLE");
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    sidecars: SIDECARS.filter(suffix => existsSync(`${path}${suffix}`)).map(suffix => suffix.slice(1)),
  };
}

type AppliedEntry = { readonly id: string; readonly sha256: string };

/** The applied vector exactly as the migration-vector gate reads it, so the digests are comparable. */
function appliedEntries(path: string): readonly AppliedEntry[] {
  const db = new AuthorityDb(path, undefined, { fileMustExist: true, readonly: true });
  try {
    if (!db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) {
      return [];
    }
    return db.db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id")
      .all() as AppliedEntry[];
  } finally {
    db.close();
  }
}

function checksOf(gates: readonly ReleaseGate[]): MigrationRehearsalChecks {
  const actual = (name: string): Record<string, unknown> => {
    const found = gates.find(item => item.name === name)?.actual;
    return typeof found === "object" && found !== null ? found as Record<string, unknown> : {};
  };
  const quickCheck = actual("quick-check")["quick_check"];
  const violations = actual("foreign-key-check")["violations"];
  return {
    quick_check: typeof quickCheck === "string" ? quickCheck : null,
    foreign_key_violations: typeof violations === "number" ? violations : null,
    migration_vector_ok: gates.find(item => item.name === "migration-vector")?.ok === true,
  };
}

/**
 * The receipt a pre-activation `release gates --phase pre-activation` reads: the vector the source
 * database is on, the vector the rehearsed migration landed on, the migrations applied to get
 * there, and the three checks on the migrated copy. It is created exclusively and 0600, so a
 * receipt can never be silently replaced by a later rehearsal of a different database.
 */
function writeReceipt(path: string, body: Record<string, unknown>): void {
  if (!isAbsolute(path)) throw new JarvisError("MIGRATION_REHEARSAL_RECEIPT_INVALID");
  try {
    writeFileSync(path, `${JSON.stringify(body)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    throw new JarvisError("MIGRATION_REHEARSAL_RECEIPT_UNWRITABLE");
  }
}

/**
 * Applies the pending migrations to a scratch copy of a database and gates the result, so an
 * operator learns whether activation's ExecStartPre migrate would succeed without letting it run
 * against the real authority. The source is only ever read: it is hashed before and after, and a
 * rehearsal that observed any change to it fails instead of reporting a rehearsal result.
 */
export async function runMigrationRehearsal(input: {
  readonly sourcePath: string;
  readonly scratchParent?: string;
  readonly receiptPath?: string;
  readonly now?: Date;
}): Promise<MigrationRehearsalResult> {
  let before: SourceObservation;
  try {
    before = observe(input.sourcePath);
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("MIGRATION_REHEARSAL_SOURCE_UNAVAILABLE");
  }
  const scratch = mkdtempSync(join(input.scratchParent ?? tmpdir(), "jarvis-migrate-rehearse-"));
  try {
    const copyPath = join(scratch, basename(input.sourcePath));
    copyFileSync(input.sourcePath, copyPath);
    for (const suffix of SIDECARS) {
      if (existsSync(`${input.sourcePath}${suffix}`)) {
        copyFileSync(`${input.sourcePath}${suffix}`, `${copyPath}${suffix}`);
      }
    }
    const appliedBefore = appliedEntries(copyPath);
    const db = new AuthorityDb(copyPath, undefined, { fileMustExist: true });
    try {
      await db.migrate();
    } finally {
      db.close();
    }
    const appliedAfter = appliedEntries(copyPath);
    const beforeIds = new Set(appliedBefore.map(entry => entry.id));
    const introduced = appliedAfter.filter(entry => !beforeIds.has(entry.id)).map(entry => entry.id);
    const gates: ReleaseGate[] = [
      quickCheckGate(copyPath),
      foreignKeyCheckGate(copyPath),
      await migrationVectorGate(copyPath),
    ];
    const after = observe(input.sourcePath);
    if (after.sha256 !== before.sha256 || after.bytes !== before.bytes || after.mtime_ms !== before.mtime_ms) {
      throw new JarvisError("MIGRATION_REHEARSAL_SOURCE_MUTATED");
    }
    const failed = gates.filter(gate => !gate.ok).map(gate => gate.name);
    const result: MigrationRehearsalResult = {
      schema_version: 1,
      ok: failed.length === 0,
      source: { ...before, untouched: true },
      source_vector_digest: migrationVectorHash(appliedBefore),
      target_vector_digest: migrationVectorHash(appliedAfter),
      applied_migrations: introduced,
      pending_before: introduced.length,
      applied_before: appliedBefore.length,
      applied_after: appliedAfter.length,
      checks: checksOf(gates),
      gates,
      failed,
    };
    if (input.receiptPath === undefined) return result;
    writeReceipt(input.receiptPath, {
      kind: MIGRATION_REHEARSAL_RECEIPT_KIND,
      ...result,
      recorded_at: (input.now ?? new Date()).toISOString(),
    });
    return { ...result, receipt: input.receiptPath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
