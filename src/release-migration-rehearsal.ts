import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

export type MigrationRehearsalResult = {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly source: SourceObservation & { readonly untouched: true };
  readonly applied_migrations: readonly string[];
  readonly pending_before: number;
  readonly applied_before: number;
  readonly applied_after: number;
  readonly gates: readonly ReleaseGate[];
  readonly failed: readonly string[];
};

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

function appliedIds(path: string): readonly string[] {
  const db = new AuthorityDb(path, undefined, { fileMustExist: true, readonly: true });
  try {
    if (!db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) {
      return [];
    }
    return (db.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>)
      .map(row => row.id);
  } finally {
    db.close();
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
    const appliedBefore = appliedIds(copyPath);
    const db = new AuthorityDb(copyPath, undefined, { fileMustExist: true });
    try {
      await db.migrate();
    } finally {
      db.close();
    }
    const appliedAfter = appliedIds(copyPath);
    const introduced = appliedAfter.filter(id => !appliedBefore.includes(id));
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
    return {
      schema_version: 1,
      ok: failed.length === 0,
      source: { ...before, untouched: true },
      applied_migrations: introduced,
      pending_before: introduced.length,
      applied_before: appliedBefore.length,
      applied_after: appliedAfter.length,
      gates,
      failed,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
