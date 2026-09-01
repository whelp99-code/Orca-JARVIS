import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedFile } from "./personal-os-protected-paths.js";

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

export async function backupSqlite(input: {
  readonly sourcePath: string;
  readonly destPath: string;
}): Promise<BackupResult> {
  const sourcePath = assertIsolatedFile(input.sourcePath);
  const destPath = assertIsolatedFile(input.destPath);
  mkdirSync(dirname(destPath), { recursive: true });
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destPath);
  } catch (error) {
    db.close();
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_BACKUP_FAILED");
  }
  db.close();
  const check = quickCheck(destPath);
  if (check !== "ok") throw new PersonalOsError("E_BACKUP_FAILED");
  return { destPath, quick_check: check, ...digestFile(destPath) };
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
