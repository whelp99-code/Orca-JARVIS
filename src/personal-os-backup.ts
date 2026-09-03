import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

export function restoreSqlite(input: {
  readonly backupPath: string;
  readonly destPath: string;
}): BackupResult {
  const backupPath = assertIsolatedFile(input.backupPath);
  const destPath = assertIsolatedFile(input.destPath);
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    copyFileSync(backupPath, destPath);
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
  }
  const check = quickCheck(destPath);
  if (check !== "ok") throw new PersonalOsError("E_RESTORE_FAILED");
  return { destPath, quick_check: check, ...digestFile(destPath) };
}
