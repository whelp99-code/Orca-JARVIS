import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { Task30MigrationRecovery } from "./migration-task30-recovery.js";
import type { PersistenceErrorFactory } from "./personal-persistence-values.js";

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function row(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRow(value) ? value : undefined;
}

function checksum(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export class MigrationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly configuredPath: string | undefined,
    private readonly error: PersistenceErrorFactory,
  ) {}

  private directory(): string {
    return this.configuredPath ?? join(dirname(fileURLToPath(import.meta.url)), "../migrations");
  }

  private async files(): Promise<readonly string[]> {
    return (await readdir(this.directory())).filter(file => file.endsWith(".sql")).sort();
  }

  async migrate(): Promise<void> {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const migrations = await Promise.all((await this.files()).map(async id => {
      const body = await readFile(join(this.directory(), id));
      return { id, body, digest: checksum(body) };
    }));
    const recovery = new Task30MigrationRecovery(this.database, this.error);
    this.assertSupportedHistory(migrations.map(migration => migration.id), recovery);
    for (const migration of migrations) {
      const prior = row(this.database.prepare(
        "SELECT checksum FROM schema_migrations WHERE id=?",
      ).get(migration.id));
      if (prior !== undefined && prior["checksum"] !== migration.digest) {
        throw this.error("MIGRATION_CHECKSUM_MISMATCH", migration.id);
      }
    }
    recovery.recoverRejectedCandidate();
    for (const migration of migrations) {
      if (migration.id === "042_memory_deletion_proof.sql"
        || migration.id === "045_task30_schema_compatibility.sql") {
        recovery.prepareLegacyDeletionSnapshot();
      }
      const prior = row(this.database.prepare(
        "SELECT checksum FROM schema_migrations WHERE id=?",
      ).get(migration.id));
      if (prior === undefined) {
        this.database.transaction(() => {
          this.database.exec(migration.body.toString("utf8"));
          this.database.prepare(
            "INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)",
          ).run(migration.id, migration.digest, new Date().toISOString());
        }).immediate();
      }
    }
    recovery.restorePreservedKeys();
  }

  async assertReady(): Promise<void> {
    const journal = this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    ).get();
    if (journal === undefined) throw this.error("MIGRATIONS_PENDING");
    const recovery = new Task30MigrationRecovery(this.database, this.error);
    if (recovery.hasRecoveryResidue()) throw this.error("MIGRATIONS_PENDING");
    const files = await this.files();
    this.assertSupportedHistory(files);
    for (const id of files) {
      const prior = row(this.database.prepare("SELECT checksum FROM schema_migrations WHERE id=?").get(id));
      if (prior === undefined) throw this.error("MIGRATIONS_PENDING", id);
      const body = await readFile(join(this.directory(), id));
      if (prior["checksum"] !== checksum(body)) throw this.error("MIGRATION_CHECKSUM_MISMATCH", id);
    }
  }

  private assertSupportedHistory(files: readonly string[], recovery?: Task30MigrationRecovery): void {
    const known = new Set(files);
    const applied = this.database.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
    for (const entry of applied) {
      // Only migrate() may enter the existing, checksum/layout/data-validated
      // rejected Task30 recovery path. Readiness never authorizes that transition.
      if (!known.has(entry.id) && !recovery?.recognizesRejectedMigration(entry.id)) {
        throw this.error("MIGRATION_VERSION_UNSUPPORTED");
      }
    }
  }

}
