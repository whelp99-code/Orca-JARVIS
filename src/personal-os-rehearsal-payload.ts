import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { JarvisError } from "./db.js";
import { MigrationStore } from "./migration-store.js";
import { PersonalOsError } from "./personal-os-errors.js";

const STUB_CLI = "export {};";
const FALLBACK_POLICY = '{"schema_version":1,"jarvis_rpo_ms":900000,"provider_rpo_ms":90000000}\n';

export function writeRehearsalPayload(input: {
  readonly stage: string;
  readonly sourceRoot: string;
}): void {
  const cliSource = join(input.sourceRoot, "dist/src/cli.js");
  if (!existsSync(cliSource)) throw new PersonalOsError("E_REHEARSAL_GATE");
  const cli = readFileSync(cliSource, "utf8");
  if (cli.trim() === STUB_CLI) throw new PersonalOsError("E_REHEARSAL_GATE");
  mkdirSync(join(input.stage, "dist/src"), { recursive: true });
  mkdirSync(join(input.stage, "config"), { recursive: true });
  mkdirSync(join(input.stage, "migrations"), { recursive: true });
  copyFileSync(join(input.sourceRoot, "package.json"), join(input.stage, "package.json"));
  copyFileSync(cliSource, join(input.stage, "dist/src/cli.js"));
  const runtime = join(input.sourceRoot, "dist/src/cli-runtime.mjs");
  if (existsSync(runtime)) copyFileSync(runtime, join(input.stage, "dist/src/cli-runtime.mjs"));
  const policy = join(input.sourceRoot, "config/backup-policy.json");
  if (existsSync(policy)) copyFileSync(policy, join(input.stage, "config/backup-policy.json"));
  else writeFileSync(join(input.stage, "config/backup-policy.json"), FALLBACK_POLICY);
  const migrations = join(input.sourceRoot, "migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    copyFileSync(join(migrations, name), join(input.stage, "migrations", name));
  }
}

export async function migrateRehearsalSqlite(input: {
  readonly dbPath: string;
  readonly migrationsPath: string;
}): Promise<void> {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const database = openUnderSwapAdmission(input.dbPath, () => new Database(input.dbPath));
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    if (String(database.pragma("journal_mode", { simple: true })).toLowerCase() !== "wal") {
      database.pragma("journal_mode = WAL");
    }
    const store = new MigrationStore(
      database,
      input.migrationsPath,
      (code, message) => new JarvisError(code, message),
    );
    await store.migrate();
  } finally {
    database.close();
  }
}

export function assertMigratedSchema(dbPath: string): void {
  const database = openUnderSwapAdmission(dbPath,
    () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ readonly name: string }>;
    const names = tables.map((row) => row.name);
    if (!names.includes("schema_migrations") || names.includes("sentinel")) {
      throw new PersonalOsError("E_REHEARSAL_GATE");
    }
    const row = database.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { readonly n: number };
    if (row.n <= 1) throw new PersonalOsError("E_REHEARSAL_GATE");
  } finally {
    database.close();
  }
}
