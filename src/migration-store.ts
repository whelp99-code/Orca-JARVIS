import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
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
    for (const id of await this.files()) {
      const body = await readFile(join(this.directory(), id));
      const digest = checksum(body);
      const prior = row(this.database.prepare("SELECT checksum FROM schema_migrations WHERE id=?").get(id));
      if (prior !== undefined && prior["checksum"] !== digest) throw this.error("MIGRATION_CHECKSUM_MISMATCH", id);
      if (prior === undefined) {
        this.database.transaction(() => {
          this.database.exec(body.toString("utf8"));
          this.database.prepare(
            "INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)",
          ).run(id, digest, new Date().toISOString());
        }).immediate();
      }
    }
  }

  async assertReady(): Promise<void> {
    const journal = this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    ).get();
    if (journal === undefined) throw this.error("MIGRATIONS_PENDING");
    for (const id of await this.files()) {
      const prior = row(this.database.prepare("SELECT checksum FROM schema_migrations WHERE id=?").get(id));
      if (prior === undefined) throw this.error("MIGRATIONS_PENDING", id);
      const body = await readFile(join(this.directory(), id));
      if (prior["checksum"] !== checksum(body)) throw this.error("MIGRATION_CHECKSUM_MISMATCH", id);
    }
  }
}
