import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import Database from "better-sqlite3";
import { type DeploymentEnvironment, resolveDeploymentRoots } from "./personal-os-deployment-roots.js";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedFile } from "./personal-os-protected-paths.js";

/** The live authority database and the backup root beside it, in the configured deployment. */
export function productionBackupSource(environment?: DeploymentEnvironment): string {
  return resolveDeploymentRoots(environment).jarvisDb;
}
export function productionBackupRoot(environment?: DeploymentEnvironment): string {
  return resolveDeploymentRoots(environment).backupRoot;
}
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
    // A backup opens the live authority without going through AuthorityDb, so it asks the same
    // question that constructor asks. Copying a file that is being replaced would produce a
    // faithful copy of a database about to stop existing, and the descriptor would make the
    // replacement refuse; refusing the backup instead says what actually happened.
    const db = openUnderSwapAdmission(sourcePath,
      () => new Database(sourcePath, { readonly: true, fileMustExist: true }));
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
}): { readonly sourcePath: string; readonly backupRoot: string } {
  const sourcePath = productionBackupSource();
  const backupRoot = productionBackupRoot();
  if (resolve(input.sourcePath) !== sourcePath || resolve(input.backupRoot) !== backupRoot) {
    throw new PersonalOsError("E_BACKUP_PATH");
  }
  return { sourcePath, backupRoot };
}

export function productionBackupDestination(now: Date, entropy: Buffer): string {
  if (!Number.isFinite(now.getTime())) throw new PersonalOsError("E_CLOCK_INVALID");
  if (entropy.byteLength !== PRODUCTION_BACKUP_ENTROPY_BYTES) throw new PersonalOsError("E_BACKUP_PATH");
  const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return join(productionBackupRoot(), `jarvis-${stamp}-${entropy.toString("hex")}.sqlite`);
}

function secureProductionSource(sourcePath: string): void {
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

function secureProductionRoot(backupRoot: string): void {
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

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new PersonalOsError("E_RESTORE_FAILED");
  return name;
}

function logicalDigestFrom(db: Database.Database): string {
  const hash = createHash("sha256");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { readonly name: string }[];
  for (const table of tables) {
    hash.update(quoteIdent(table.name));
    hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${quoteIdent(table.name)}`).all()));
  }
  return hash.digest("hex");
}

function logicalDigest(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return logicalDigestFrom(db);
  } finally {
    db.close();
  }
}

function cloneFromBackup(dest: Database.Database, backupPath: string): void {
  dest.prepare("ATTACH ? AS restore_src").run(backupPath);
  try {
    dest.pragma("foreign_keys = OFF");
    dest.exec("BEGIN IMMEDIATE");
    const destTables = dest
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { readonly name: string }[];
    for (const table of destTables) dest.exec(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
    const objects = dest
      .prepare(
        `SELECT type, name, sql FROM restore_src.sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
      )
      .all() as { readonly type: string; readonly name: string; readonly sql: string }[];
    for (const object of objects) {
      dest.exec(object.sql);
      if (object.type === "table") {
        dest.exec(`INSERT INTO ${quoteIdent(object.name)} SELECT * FROM restore_src.${quoteIdent(object.name)}`);
      }
    }
    dest.exec("COMMIT");
  } catch (error) {
    if (dest.inTransaction) dest.exec("ROLLBACK");
    throw error;
  } finally {
    dest.exec("DETACH restore_src");
  }
}

function restoreExistingDest(backupPath: string, destPath: string): BackupResult {
  let dest: Database.Database | undefined;
  try {
    dest = new Database(destPath, { fileMustExist: true });
    dest.pragma("busy_timeout = 0");
    dest.pragma("locking_mode = EXCLUSIVE");
    dest.exec("BEGIN IMMEDIATE");
    dest.exec("COMMIT");
    cloneFromBackup(dest, backupPath);
    dest.pragma("wal_checkpoint(TRUNCATE)");
    const check = dest.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new PersonalOsError("E_RESTORE_FAILED");
    if (logicalDigestFrom(dest) !== logicalDigest(backupPath)) throw new PersonalOsError("E_RESTORE_FAILED");
    dest.close();
    dest = undefined;
    return { destPath, quick_check: "ok", ...digestFile(destPath) };
  } catch (error) {
    dest?.close();
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
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
  if (existsSync(destPath)) return restoreExistingDest(backupPath, destPath);
  const staging = join(dirname(destPath), `.restore-${randomBytes(8).toString("hex")}.sqlite`);
  try {
    copyFileSync(backupPath, staging);
    chmodSync(staging, 0o600);
    const check = quickCheck(staging);
    if (check !== "ok") throw new PersonalOsError("E_RESTORE_FAILED");
    try {
      copyFileSync(staging, destPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new PersonalOsError("E_RESTORE_FAILED");
      }
      throw error;
    }
    chmodSync(destPath, 0o600);
    if (logicalDigest(destPath) !== logicalDigest(backupPath)) throw new PersonalOsError("E_RESTORE_FAILED");
    return { destPath, quick_check: check, ...digestFile(destPath) };
  } catch (error) {
    rmSync(staging, { force: true });
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_RESTORE_FAILED");
  }
}
