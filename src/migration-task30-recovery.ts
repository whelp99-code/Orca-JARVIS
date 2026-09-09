import type Database from "better-sqlite3";
import type { PersistenceErrorFactory } from "./personal-persistence-values.js";

const REJECTED_MIGRATIONS = [
  ["040_memory_effect_requests.sql", "619e22969bb3076c513ac7fba13101df79d0e2b0ab70ee8bb5fe0976a53c3ae2"],
  ["041_memory_effect_delegations.sql", "c00586bce2b34fc07e777b4ef3a6043bf0a7938ad35e40a0ba449aa186b4e510"],
  ["042_memory_effect_progress.sql", "061a1c6c49bb6c9aa8497b77c56d28c060c30254019faf2c2ccb7b15d91b7454"],
  ["043_memory_erasure_ledger.sql", "6d63cda882418313f54cc546995297d74ebef6921145be94b82fb6396c04b707"],
  ["044_memory_targets_tombstones.sql", "40e98be8fdcb90ef3c9817fcc2a6d9e10be4571344fd50b43615c7b1795d1851"],
] as const;

const EFFECT_TABLES = [
  "memory_effect_requests",
  "memory_effect_delegations",
  "memory_effect_delegation_revocations",
  "memory_effect_delegation_uses",
  "memory_effect_progress",
  "memory_erasure_ledger",
  "memory_resolved_targets",
  "memory_effect_request_targets",
  "memory_tombstone_watermarks",
] as const;

const DROP_TABLES = [
  "memory_effect_request_targets",
  "memory_tombstone_watermarks",
  "memory_resolved_targets",
  "memory_erasure_ledger",
  "memory_provider_proof_keys",
  "memory_effect_progress",
  "memory_effect_delegation_uses",
  "memory_effect_delegation_revocations",
  "memory_effect_delegations",
  "memory_external_erasure_keys",
  "memory_effect_delegation_keys",
  "memory_effect_requests",
] as const;

const PRESERVED_KEY_TABLES = [
  ["memory_effect_delegation_keys", "_task30_rejected_delegation_keys"],
  ["memory_external_erasure_keys", "_task30_rejected_external_keys"],
  ["memory_provider_proof_keys", "_task30_rejected_provider_keys"],
] as const;

const LEGACY_DELETION_SNAPSHOT = "_task30_legacy_deletion_requests_snapshot";
const LEGACY_TOMBSTONE_SNAPSHOT = "_task30_legacy_tombstones_snapshot";

export class Task30MigrationRecovery {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  recognizesRejectedMigration(id: string): boolean {
    return REJECTED_MIGRATIONS.some(([known]) => known === id);
  }

  recoverRejectedCandidate(): void {
    const rows = this.database.prepare(
      `SELECT id,checksum FROM schema_migrations
       WHERE id IN (${REJECTED_MIGRATIONS.map(() => "?").join(",")}) ORDER BY id`,
    ).all(...REJECTED_MIGRATIONS.map(([id]) => id)) as Array<{
      readonly id: string;
      readonly checksum: string;
    }>;
    if (rows.length === 0) return;
    const expected = REJECTED_MIGRATIONS.slice(0, rows.length);
    for (const [index, row] of rows.entries()) {
      const identity = expected[index];
      if (identity === undefined || row.id !== identity[0]) {
        throw this.error("MIGRATION_REJECTED_TASK30_LAYOUT_INVALID");
      }
      if (row.checksum !== identity[1]) throw this.error("MIGRATION_CHECKSUM_MISMATCH", row.id);
    }
    if (this.hasCurrentTask30Migration()) {
      throw this.error("MIGRATION_REJECTED_TASK30_LAYOUT_INVALID");
    }
    if (EFFECT_TABLES.some(table => this.tableExists(table) && this.rowCount(table) > 0)) {
      throw this.error("MIGRATION_REJECTED_TASK30_DATA_PRESENT");
    }
    this.database.transaction(() => {
      for (const [source, backup] of PRESERVED_KEY_TABLES) {
        if (this.tableExists(source)) this.database.exec(`CREATE TABLE ${backup} AS SELECT * FROM ${source}`);
      }
      for (const table of DROP_TABLES) this.database.exec(`DROP TABLE IF EXISTS ${table}`);
      this.database.prepare(
        `DELETE FROM schema_migrations
         WHERE id IN (${REJECTED_MIGRATIONS.map(() => "?").join(",")})`,
      ).run(...REJECTED_MIGRATIONS.map(([id]) => id));
    }).immediate();
  }

  prepareLegacyDeletionSnapshot(): void {
    if (this.migrationApplied("045_task30_schema_compatibility.sql")) return;
    this.database.transaction(() => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS ${LEGACY_DELETION_SNAPSHOT}(
        deletion_id TEXT PRIMARY KEY, correlation_id TEXT, idempotency_key TEXT, operation TEXT,
        subject_digest TEXT, scope_digest TEXT, target_digest TEXT, args_digest TEXT,
        requested_by TEXT, state TEXT, confirmation_request_id TEXT, confirmation_receipt_id TEXT,
        confirmation_receipt_digest TEXT, lease_owner TEXT, lease_fence INTEGER,
        lease_expires_at TEXT, expires_at TEXT, created_at TEXT, updated_at TEXT
      )`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS ${LEGACY_TOMBSTONE_SNAPSHOT}(
        tombstone_id TEXT PRIMARY KEY, deletion_id TEXT, subject_digest TEXT, scope_digest TEXT,
        target_digest TEXT, args_digest TEXT, approval_request_id TEXT, approval_receipt_id TEXT,
        approval_receipt_digest TEXT, effect_lease_owner TEXT, effect_lease_fence INTEGER,
        effective_at TEXT, tombstone_digest TEXT, created_at TEXT
      )`);
      if (this.tableHasColumn("memory_deletion_requests", "subject_digest")) {
        this.database.exec(`INSERT OR IGNORE INTO ${LEGACY_DELETION_SNAPSHOT}
          SELECT deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,
            target_digest,args_digest,requested_by,state,confirmation_request_id,
            confirmation_receipt_id,confirmation_receipt_digest,lease_owner,lease_fence,
            lease_expires_at,expires_at,created_at,updated_at FROM memory_deletion_requests`);
      }
      if (this.objectType("memory_tombstones") === "table") {
        this.database.exec(`INSERT OR IGNORE INTO ${LEGACY_TOMBSTONE_SNAPSHOT}
          SELECT tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,
            approval_request_id,approval_receipt_id,approval_receipt_digest,effect_lease_owner,
            effect_lease_fence,effective_at,tombstone_digest,created_at FROM memory_tombstones`);
      }
    }).immediate();
  }

  restorePreservedKeys(): void {
    const existing = PRESERVED_KEY_TABLES.filter(([, backup]) => this.tableExists(backup));
    if (existing.length === 0) return;
    this.database.transaction(() => {
      for (const [target, backup] of existing) {
        if (this.rowCount(backup) > 0) {
          this.database.exec(`INSERT OR IGNORE INTO ${target} SELECT * FROM ${backup}`);
        }
        this.database.exec(`DROP TABLE ${backup}`);
      }
    }).immediate();
  }

  hasRecoveryResidue(): boolean {
    return PRESERVED_KEY_TABLES.some(([, backup]) => this.tableExists(backup));
  }

  private hasCurrentTask30Migration(): boolean {
    return this.database.prepare(
      "SELECT 1 FROM schema_migrations WHERE id='040_memory_tombstone_authority.sql'",
    ).get() !== undefined;
  }

  private migrationApplied(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(id) !== undefined;
  }

  private tableExists(name: string): boolean {
    return this.objectType(name) === "table";
  }

  private objectType(name: string): string | undefined {
    const row = this.database.prepare(
      "SELECT type FROM sqlite_master WHERE name=?",
    ).get(name) as { readonly type: string } | undefined;
    return row?.type;
  }

  private tableHasColumn(table: string, column: string): boolean {
    if (!this.tableExists(table)) return false;
    return (this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      readonly name: string;
    }>).some(value => value.name === column);
  }

  private rowCount(table: string): number {
    return Number((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    }).count);
  }
}
