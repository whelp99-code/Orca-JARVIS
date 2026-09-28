import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { AuthorityDb } from "./db.js";
import { backupSqlite, type BackupResult } from "./personal-os-backup.js";
import { migrateRehearsalSqlite } from "./personal-os-rehearsal-payload.js";
import Database from "better-sqlite3";

export type SeededDatabase = {
  readonly dbPath: string;
  readonly keyRows: number;
  readonly migrationRows: number;
  readonly fixtureSubject: string;
};

async function writeAnchor(dir: string, name: string): Promise<string> {
  const pair = generateKeyPairSync("ed25519");
  const path = join(dir, `${name}.pub.pem`);
  writeFileSync(path, pair.publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(join(dir, `${name}.pem`), pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return path;
}

export async function seedFixtureDatabase(input: {
  readonly dbPath: string;
  readonly migrationsPath: string;
  readonly anchorDir: string;
  readonly subject: string;
}): Promise<SeededDatabase> {
  await migrateRehearsalSqlite({ dbPath: input.dbPath, migrationsPath: input.migrationsPath });
  mkdirSync(input.anchorDir, { recursive: true });
  const db = new AuthorityDb(input.dbPath);
  try {
    await db.initialize({
      decision: {
        keyId: "decision-rehearsal",
        principal: "principal:owner",
        publicKeyPath: await writeAnchor(input.anchorDir, "decision"),
      },
      verifier: {
        keyId: "verifier-rehearsal",
        principal: "principal:verifier",
        publicKeyPath: await writeAnchor(input.anchorDir, "verifier"),
      },
    });
    const keyRows = (db.db.prepare("SELECT COUNT(*) AS n FROM trusted_authority_keys").get() as { n: number }).n;
    const migrationRows = Number((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n);
    db.db.pragma("wal_checkpoint(TRUNCATE)");
    return { dbPath: input.dbPath, keyRows, migrationRows, fixtureSubject: input.subject };
  } finally {
    db.close();
  }
}

export function cloneDatabase(sourcePath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(sourcePath, destPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${destPath}${suffix}`);
  }
}

export async function backupAndCheck(sourcePath: string, destPath: string): Promise<BackupResult> {
  return backupSqlite({ sourcePath, destPath });
}

export function quickCheck(dbPath: string): string {
  const db = openUnderSwapAdmission(dbPath, () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return String(db.pragma("quick_check", { simple: true }));
  } finally {
    db.close();
  }
}

export function tableCount(dbPath: string, table: string): number {
  const db = openUnderSwapAdmission(dbPath, () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}
