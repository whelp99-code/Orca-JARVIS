import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, migrationCopy, migrationCount, personalDb, removeMigrationCopy, T0 } from "./personal-operations-test-helpers.js";

const TABLES = [
  "daily_loop_runs", "daily_loop_steps", "daily_loop_checkpoints",
  "notification_intents", "notification_deliveries",
  "memory_candidates", "memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events",
  "memory_deletion_requests", "memory_tombstones", "remote_principals", "webauthn_credentials",
  "webauthn_challenges", "webauthn_assertions", "retention_jobs", "personal_operation_audit_events",
] as const;

const AUTH_COLUMNS = {
  remote_principals: ["principal_id", "state", "subject_digest", "enrollment_request_id", "enrollment_receipt_id", "enrollment_receipt_digest", "enrollment_expires_at", "activated_at", "revoked_at", "created_at"],
  webauthn_credentials: ["credential_id", "principal_id", "public_key_cose", "public_key_digest", "sign_count", "state", "rp_id", "origin", "created_at", "revoked_at"],
  webauthn_challenges: ["challenge_id", "principal_id", "credential_id", "session_id", "command_digest", "target_digest", "args_digest", "challenge_digest", "nonce_digest", "rp_id", "origin", "state", "issued_at", "expires_at", "consumed_at"],
  webauthn_assertions: ["assertion_id", "challenge_id", "principal_id", "credential_id", "session_id", "command_digest", "assertion_digest", "sign_count", "user_verified", "asserted_at"],
} as const;

describe("personal operations migration", () => {
  it("publishes the exact table and authentication column inventories", async () => {
    // Given a fresh authority database
    const db = await personalDb();
    try {
      // When migration 033 is applied
      const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
      // Then every personal operations table exists and auth storage is allowlisted
      expect(tables).toEqual(expect.arrayContaining([...TABLES]));
      for (const [table, expected] of Object.entries(AUTH_COLUMNS)) {
        const columns = (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
        expect(columns, table).toEqual(expected);
        expect(columns.some(column => /private|biometric|secret|payload|memory|content/i.test(column))).toBe(false);
      }
    } finally { closePersonalDb(db); }
  });

  it("upgrades and restores a pre-033 database without changing existing data", async () => {
    // Given a pre-033 database and a byte-for-byte backup
    const pre033 = migrationCopy(false);
    const upgrade = await personalDb(pre033);
    const backup = `${upgrade.filename}.backup`;
    upgrade.db.prepare("INSERT INTO projects(id,target_kind,created_at) VALUES(?,?,?)").run("sentinel-project", "codex", T0);
    upgrade.db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(upgrade.filename, backup);
    upgrade.close();
    const full = migrationCopy();
    const restoredPath = `${backup}.restored`;
    copyFileSync(backup, restoredPath);
    const upgraded = new AuthorityDb(upgrade.filename, full);
    const restored = new AuthorityDb(restoredPath, full);
    try {
      // When both copies apply 033 repeatedly
      await upgraded.migrate(); await upgraded.migrate();
      await restored.migrate(); await restored.migrate();
      // Then the sentinel and one stable 033 checksum survive in both
      for (const db of [upgraded, restored]) {
        expect(db.db.prepare("SELECT id FROM projects WHERE id='sentinel-project'").get()).toEqual({ id: "sentinel-project" });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='033_personal_operations.sql'").get()).toEqual({ n: 1 });
        await expect(db.assertMigrationsReady()).resolves.toBeUndefined();
      }
      expect(upgraded.db.prepare("SELECT checksum FROM schema_migrations WHERE id='033_personal_operations.sql'").get()).toEqual(restored.db.prepare("SELECT checksum FROM schema_migrations WHERE id='033_personal_operations.sql'").get());
    } finally {
      upgraded.close(); restored.close();
      removeMigrationCopy(pre033); removeMigrationCopy(full);
      rmSync(join(upgrade.filename, ".."), { recursive: true, force: true });
    }
  });

  it("remains independent when future migration 032 is inserted into sort order", async () => {
    // Given isolated migration directories with a harmless future 032
    const directory = migrationCopy();
    const future032 = "CREATE TABLE future_personal_context_sentinel (id TEXT PRIMARY KEY);\n";
    const existing = await personalDb(directory);
    try {
      expect(existing.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: migrationCount(directory) });
      writeFileSync(join(directory, "032_personal_context.sql"), future032);
      // When an existing 033 database and a fresh database migrate
      await existing.migrate();
      const fresh = await personalDb(directory);
      try {
        // Then each applies 032 once and retains the identical 033 checksum
        expect(existing.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='032_personal_context.sql'").get()).toEqual({ n: 1 });
        expect(fresh.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='032_personal_context.sql'").get()).toEqual({ n: 1 });
        expect(existing.db.prepare("SELECT checksum FROM schema_migrations WHERE id='033_personal_operations.sql'").get()).toEqual(fresh.db.prepare("SELECT checksum FROM schema_migrations WHERE id='033_personal_operations.sql'").get());
      } finally { closePersonalDb(fresh); }
    } finally { closePersonalDb(existing); removeMigrationCopy(directory); }
  });

  it("rolls back a failed 033 transaction and retries cleanly", async () => {
    // Given an isolated migration with a deterministic failure after schema creation
    const directory = migrationCopy();
    const migration = join(directory, "033_personal_operations.sql");
    const original = readFileSync(migration, "utf8");
    writeFileSync(migration, `${original}\nINSERT INTO missing_task8_table VALUES (1);\n`);
    const root = mkdtempSync(join(tmpdir(), "jarvis-personal-failure-"));
    const db = new AuthorityDb(join(root, "authority.sqlite"), directory);
    try {
      // When 033 fails and its exact bytes are restored before retry
      await expect(db.migrate()).rejects.toThrow("no such table: missing_task8_table");
      // Then neither partial schema nor a migration journal row remains
      expect(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_loop_runs'").get()).toBeUndefined();
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='033_personal_operations.sql'").get()).toEqual({ n: 0 });
      writeFileSync(migration, original);
      await expect(db.migrate()).resolves.toBeUndefined();
      expect(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_loop_runs'").get()).toEqual({ name: "daily_loop_runs" });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); removeMigrationCopy(directory); }
  });

  it("journals the exact migration bytes once", async () => {
    // Given the tracked migration bytes
    const source = readFileSync(join(process.cwd(), "migrations", "033_personal_operations.sql"));
    const expected = createHash("sha256").update(source).digest("hex");
    // When migrations run twice
    const db = await personalDb();
    try { await db.migrate();
      // Then the journal binds one exact checksum
      expect(db.db.prepare("SELECT checksum FROM schema_migrations WHERE id='033_personal_operations.sql'").get()).toEqual({ checksum: expected });
    } finally { closePersonalDb(db); }
  });
});
