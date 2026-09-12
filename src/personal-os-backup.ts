import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedFile } from "./personal-os-protected-paths.js";

export const PRODUCTION_BACKUP_SOURCE = "/home/jm/.local/state/orca-jarvis/jarvis.sqlite" as const;
export const PRODUCTION_BACKUP_ROOT = "/home/jm/.local/state/orca-jarvis/backups" as const;
const PRODUCTION_BACKUP_ENTROPY_BYTES = 8;

export type BackupResult = {
  readonly destPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly quick_check: string;
};

function digestFile(path: string): { readonly sha256: string; readonly bytes: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

function quickCheck(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("quick_check", { simple: true });
    return typeof result === "string" ? result : "fail";
  } finally {
    db.close();
  }
}

async function performOnlineBackup(sourcePath: string, destPath: string): Promise<BackupResult> {
  if (existsSync(destPath)) throw new PersonalOsError("E_BACKUP_PATH");
  try {
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(destPath);
    } finally {
      db.close();
    }
    chmodSync(destPath, 0o600);
    const check = quickCheck(destPath);
    if (check !== "ok") throw new PersonalOsError("E_BACKUP_FAILED");
    return { destPath, quick_check: check, ...digestFile(destPath) };
  } catch (error) {
    rmSync(destPath, { force: true });
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_BACKUP_FAILED");
  }
}

export async function backupSqlite(input: {
  readonly sourcePath: string;
  readonly destPath: string;
}): Promise<BackupResult> {
  const sourcePath = assertIsolatedFile(input.sourcePath);
  const destPath = assertIsolatedFile(input.destPath);
  mkdirSync(dirname(destPath), { recursive: true });
  return performOnlineBackup(sourcePath, destPath);
}

export function assertProductionBackupPaths(input: {
  readonly sourcePath: string;
  readonly backupRoot: string;
}): { readonly sourcePath: typeof PRODUCTION_BACKUP_SOURCE; readonly backupRoot: typeof PRODUCTION_BACKUP_ROOT } {
  if (resolve(input.sourcePath) !== PRODUCTION_BACKUP_SOURCE || resolve(input.backupRoot) !== PRODUCTION_BACKUP_ROOT) {
    throw new PersonalOsError("E_BACKUP_PATH");
  }
  return { sourcePath: PRODUCTION_BACKUP_SOURCE, backupRoot: PRODUCTION_BACKUP_ROOT };
}

export function productionBackupDestination(now: Date, entropy: Buffer): string {
  if (!Number.isFinite(now.getTime())) throw new PersonalOsError("E_CLOCK_INVALID");
  if (entropy.byteLength !== PRODUCTION_BACKUP_ENTROPY_BYTES) throw new PersonalOsError("E_BACKUP_PATH");
  const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return join(PRODUCTION_BACKUP_ROOT, `jarvis-${stamp}-${entropy.toString("hex")}.sqlite`);
}

function secureProductionSource(sourcePath: typeof PRODUCTION_BACKUP_SOURCE): void {
  try {
    const uid = process.getuid?.();
    const stat = lstatSync(sourcePath);
    if (uid === undefined || stat.uid !== uid || stat.isSymbolicLink() || !stat.isFile()
      || realpathSync(sourcePath) !== sourcePath || (stat.mode & 0o022) !== 0) {
      throw new PersonalOsError("E_BACKUP_PATH");
    }
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_BACKUP_PATH");
  }
}

function secureProductionRoot(backupRoot: typeof PRODUCTION_BACKUP_ROOT): void {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new PersonalOsError("E_BACKUP_PATH");
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const stat = lstatSync(backupRoot);
    if (stat.uid !== uid || stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(backupRoot) !== backupRoot) {
      throw new PersonalOsError("E_BACKUP_PATH");
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(backupRoot, 0o700);
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_BACKUP_PATH");
  }
}

export async function backupProductionSqlite(input: {
  readonly sourcePath: string;
  readonly backupRoot: string;
  readonly now?: Date;
}): Promise<BackupResult> {
  const paths = assertProductionBackupPaths(input);
  secureProductionSource(paths.sourcePath);
  secureProductionRoot(paths.backupRoot);
  const destPath = productionBackupDestination(input.now ?? new Date(), randomBytes(PRODUCTION_BACKUP_ENTROPY_BYTES));
  return performOnlineBackup(paths.sourcePath, destPath);
}

function exclusiveCheckpoint(path: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { fileMustExist: true });
    db.pragma("busy_timeout = 0");
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    db.exec("COMMIT");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
  } finally {
    db?.close();
  }
}

function logicalDigest(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hash = createHash("sha256");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { readonly name: string }[];
    for (const table of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) throw new PersonalOsError("E_RESTORE_FAILED");
      hash.update(table.name);
      hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all()));
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

function parkSqliteSet(destPath: string, parkDir: string): void {
  mkdirSync(parkDir, { recursive: true });
  const parked = join(parkDir, "main.sqlite");
  renameSync(destPath, parked);
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = destPath + suffix;
    if (existsSync(sidecar)) renameSync(sidecar, parked + suffix);
  }
}

function unparkSqliteSet(destPath: string, parkDir: string): void {
  const parked = join(parkDir, "main.sqlite");
  rmSync(destPath, { force: true });
  rmSync(destPath + "-wal", { force: true });
  rmSync(destPath + "-shm", { force: true });
  renameSync(parked, destPath);
  for (const suffix of ["-wal", "-shm"] as const) {
    if (existsSync(parked + suffix)) renameSync(parked + suffix, destPath + suffix);
  }
}

export function restoreSqlite(input: {
  readonly backupPath: string;
  readonly destPath: string;
}): BackupResult {
  const backupPath = assertIsolatedFile(input.backupPath);
  const destPath = assertIsolatedFile(input.destPath);
  if (resolve(backupPath) === resolve(destPath)) throw new PersonalOsError("E_RESTORE_FAILED");
  if (!existsSync(backupPath) || !lstatSync(backupPath).isFile()) throw new PersonalOsError("E_RESTORE_FAILED");
  try {
    if (quickCheck(backupPath) !== "ok") throw new PersonalOsError("E_RESTORE_FAILED");
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const entropy = randomBytes(8).toString("hex");
  const staging = join(dirname(destPath), `.restore-${entropy}.sqlite`);
  const parkDir = join(dirname(destPath), `.restore-park-${entropy}`);
  let parked = false;
  try {
    copyFileSync(backupPath, staging);
    chmodSync(staging, 0o600);
    const check = quickCheck(staging);
    if (check !== "ok") throw new PersonalOsError("E_RESTORE_FAILED");
    const expected = logicalDigest(backupPath);
    if (existsSync(destPath)) {
      exclusiveCheckpoint(destPath);
      parkSqliteSet(destPath, parkDir);
      parked = true;
    }
    renameSync(staging, destPath);
    if (logicalDigest(destPath) !== expected) throw new PersonalOsError("E_RESTORE_FAILED");
    if (parked) rmSync(parkDir, { recursive: true, force: true });
    return { destPath, quick_check: check, ...digestFile(destPath) };
  } catch (error) {
    rmSync(staging, { force: true });
    if (parked && existsSync(parkDir)) unparkSqliteSet(destPath, parkDir);
    rmSync(parkDir, { recursive: true, force: true });
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
  }
}
