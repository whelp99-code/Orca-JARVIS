import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrationVectorHash } from "./backend-build-files.js";
import { JarvisError } from "./db.js";
import { activateRelease, rollbackReleaseRoot } from "./release-rollback.js";

const HEX40 = /^[0-9a-f]{40}$/;
const SIDECARS = ["-wal", "-shm"] as const;

/**
 * The order the operator performs around this command. It stops and starts nothing itself: an
 * authority that is still running would write to the database being replaced, and restarting is
 * what applies the target release's own ExecStartPre migrate.
 */
export const RESTORE_SYSTEMD_ORDER = [
  "systemctl --user stop jm-jarvis-dashboard.service",
  "systemctl --user stop jm-jarvis.service",
  "systemctl --user is-active jm-jarvis.service jm-jarvis-dashboard.service  # inactive inactive",
  "<this command: release rollback --to <target> --restore-backup <backup>>",
  "systemctl --user start jm-jarvis.service",
  "systemctl --user start jm-jarvis-dashboard.service",
] as const;

export type RestoreVectorObservation = {
  readonly digest: string;
  readonly migrations: number;
  readonly source: string;
};

export type ReleaseRestoreResult = {
  readonly schema_version: 1;
  readonly rollback: "restore";
  readonly dry_run: boolean;
  readonly target_release: string;
  readonly current_target: string;
  readonly target_vector: RestoreVectorObservation;
  readonly backup: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly quick_check: string;
    readonly vector_digest: string;
    readonly applied_migrations: number;
  };
  readonly database: {
    readonly path: string;
    readonly restored: boolean;
    readonly replaced: string | null;
  };
  readonly systemd_order: readonly string[];
};

export type ReleaseRestoreInput = {
  readonly releaseRoot: string;
  readonly dbPath: string;
  readonly to: string;
  readonly backupPath: string;
  readonly dryRun: boolean;
  readonly productionRoot?: boolean;
  readonly ownerApproval?: string;
  readonly now?: Date;
};

type MigrationEntry = { readonly id: string; readonly sha256: string };

function readOnlyDatabase<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The vector a database is on, read exactly as the migration-vector gate reads it. */
function appliedVector(path: string, code: string): { readonly digest: string; readonly count: number } {
  try {
    const applied = readOnlyDatabase(path, db => db
      .prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id")
      .all() as MigrationEntry[]);
    return { digest: migrationVectorHash(applied), count: applied.length };
  } catch {
    throw new JarvisError(code);
  }
}

/**
 * The vector the target release expects: the migration files it actually ships. A release that
 * predates sealed manifests still carries its migrations, which is why this is readable for a
 * target that no `release-compatibility.json` can qualify.
 */
function targetVector(releaseDir: string): RestoreVectorObservation {
  for (const relative of ["dist/migrations", "migrations"]) {
    const directory = join(releaseDir, relative);
    let names: readonly string[];
    try {
      if (!lstatSync(directory).isDirectory()) continue;
      names = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    const entries: MigrationEntry[] = names.map(id => ({
      id,
      sha256: createHash("sha256").update(readFileSync(join(directory, id))).digest("hex"),
    }));
    return { digest: migrationVectorHash(entries), migrations: entries.length, source: relative };
  }
  throw new JarvisError("RELEASE_RESTORE_TARGET_VECTOR_UNAVAILABLE");
}

function quickCheck(path: string, code: string): string {
  let value: unknown;
  try {
    value = readOnlyDatabase(path, db => db.pragma("quick_check", { simple: true }));
  } catch {
    throw new JarvisError(code);
  }
  if (value !== "ok") throw new JarvisError(code);
  return "ok";
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Replaces the database with the backup in two atomic renames: the copy is made and checked beside
 * the destination first, the database in place is renamed aside to `.replaced-<utc>` with its
 * sidecars, and only then does the checked copy take its name. Nothing is ever written into the
 * database being replaced, and the replaced bytes are kept.
 */
function restoreDatabase(dbPath: string, backupPath: string, now: Date): string | null {
  const suffix = stamp(now);
  const temporary = `${dbPath}.restore-${suffix}`;
  const replaced = `${dbPath}.replaced-${suffix}`;
  try {
    copyFileSync(backupPath, temporary, constants.COPYFILE_EXCL);
  } catch {
    throw new JarvisError("RELEASE_RESTORE_COPY_FAILED");
  }
  try {
    quickCheck(temporary, "RELEASE_RESTORE_COPY_UNUSABLE");
  } catch (error) {
    for (const sidecar of SIDECARS) rmSync(`${temporary}${sidecar}`, { force: true });
    rmSync(temporary, { force: true });
    throw error;
  }
  // Reading the copy leaves the WAL index beside it; the restored database carries no sidecars,
  // because a backup is already checkpointed.
  for (const sidecar of SIDECARS) rmSync(`${temporary}${sidecar}`, { force: true });
  let kept: string | null = null;
  if (existsSync(dbPath)) {
    renameSync(dbPath, replaced);
    kept = replaced;
    // The write-ahead files belong to the database that was just set aside, never to the restore.
    for (const sidecar of SIDECARS) {
      if (existsSync(`${dbPath}${sidecar}`)) renameSync(`${dbPath}${sidecar}`, `${replaced}${sidecar}`);
    }
  }
  renameSync(temporary, dbPath);
  return kept;
}

function currentTarget(releaseRoot: string): string {
  try {
    return readlinkSync(join(releaseRoot, "current"));
  } catch {
    return "";
  }
}

/**
 * The documented recovery for a rollback target the three qualification checks cannot pass: a
 * target published before sealed manifests has no `release-compatibility.json` and no
 * `provider_contract_digest`, so no vector, provider contract or sealed manifest can be compared.
 * What can be compared is the backup: this refuses unless the backup's own applied migration vector
 * is exactly the vector the target release's shipped migrations describe, and unless the backup
 * passes `quick_check`. Only then is the database restored from the backup and `current` switched
 * to the target, in that order, so the target's ExecStartPre migrate has nothing left to apply.
 *
 * It stops and starts nothing: the caller performs RESTORE_SYSTEMD_ORDER around it.
 */
export function runReleaseRestore(input: ReleaseRestoreInput): ReleaseRestoreResult {
  if (!HEX40.test(input.to)) throw new JarvisError("RELEASE_ROLLBACK_INPUT_INVALID");
  const releaseRoot = rollbackReleaseRoot(input);
  const releaseDir = join(releaseRoot, "releases", input.to);
  try {
    if (!lstatSync(releaseDir).isDirectory()) throw new Error();
  } catch {
    throw new JarvisError("RELEASE_RESTORE_TARGET_UNAVAILABLE");
  }
  const vector = targetVector(releaseDir);

  let backupStat: ReturnType<typeof lstatSync>;
  try {
    backupStat = lstatSync(input.backupPath);
    if (!backupStat.isFile()) throw new Error();
  } catch {
    throw new JarvisError("RELEASE_RESTORE_BACKUP_UNAVAILABLE");
  }
  const backupCheck = quickCheck(input.backupPath, "RELEASE_RESTORE_BACKUP_UNUSABLE");
  const backupVector = appliedVector(input.backupPath, "RELEASE_RESTORE_BACKUP_UNUSABLE");
  // A backup at another schema level would be migrated forward by the target's own ExecStartPre
  // into a database the target release was never run against; that is the refusal.
  if (backupVector.digest !== vector.digest) throw new JarvisError("RELEASE_RESTORE_VECTOR_MISMATCH");

  const backup = {
    path: input.backupPath,
    sha256: createHash("sha256").update(readFileSync(input.backupPath)).digest("hex"),
    bytes: backupStat.size,
    quick_check: backupCheck,
    vector_digest: backupVector.digest,
    applied_migrations: backupVector.count,
  };
  if (input.dryRun) {
    return {
      schema_version: 1,
      rollback: "restore",
      dry_run: true,
      target_release: input.to,
      current_target: currentTarget(releaseRoot),
      target_vector: vector,
      backup,
      database: { path: input.dbPath, restored: false, replaced: null },
      systemd_order: RESTORE_SYSTEMD_ORDER,
    };
  }
  const replaced = restoreDatabase(input.dbPath, input.backupPath, input.now ?? new Date());
  return {
    schema_version: 1,
    rollback: "restore",
    dry_run: false,
    target_release: input.to,
    current_target: activateRelease(releaseRoot, input.to),
    target_vector: vector,
    backup,
    database: { path: input.dbPath, restored: true, replaced },
    systemd_order: RESTORE_SYSTEMD_ORDER,
  };
}
