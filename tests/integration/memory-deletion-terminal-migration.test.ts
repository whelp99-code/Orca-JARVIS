import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

const MIGRATION = "097_memory_deletion_terminal_refusal.sql";
const PRIOR = "096_local_retention_claim_identity.sql";

function migrationCopy(exclude: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-deletion-migration-"));
  const migrations = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
  for (const name of exclude) rmSync(join(migrations, name));
  return migrations;
}

function checksum(name: string): string {
  return createHash("sha256").update(readFileSync(join(process.cwd(), "migrations", name))).digest("hex");
}

function laneRows(db: AuthorityDb): unknown {
  return {
    requests: db.db.prepare("SELECT * FROM memory_deletion_effect_requests ORDER BY deletion_id").all(),
    events: db.db.prepare("SELECT * FROM memory_deletion_events ORDER BY event_id").all(),
    attempts: db.db.prepare("SELECT * FROM memory_deletion_attempts ORDER BY attempt_id").all(),
    proofs: db.db.prepare("SELECT * FROM memory_deletion_proofs ORDER BY deletion_id").all(),
  };
}

describe("deletion terminal-refusal migration", () => {
  it("journals the new file checksum on a fresh database", async () => {
    const db = new AuthorityDb(tempDb(), join(process.cwd(), "migrations"));
    try {
      await db.migrate();
      expect(db.db.prepare("SELECT checksum FROM schema_migrations WHERE id=?").get(MIGRATION))
        .toEqual({ checksum: checksum(MIGRATION) });
      const transition = db.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memory_deletion_effect_transition'",
      ).get() as { readonly sql: string };
      expect(transition.sql).toContain("reconciling:conflict");
    } finally { db.close(); }
  });

  it("preserves existing deletion rows byte-for-byte when upgrading from the prior migration", async () => {
    const priorMigrations = migrationCopy(readdirSync(join(process.cwd(), "migrations"))
      .filter(file => file.endsWith(".sql") && file > PRIOR));
    const prior = new AuthorityDb(tempDb(), priorMigrations);
    try {
      await prior.migrate();
      expect(prior.db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get())
        .toEqual({ id: PRIOR });
      prior.db.prepare(
        `INSERT INTO memory_deletion_effect_requests(
          deletion_id,correlation_id,idempotency_key,operation,keyed_subject_digest,scope_digest,
          target_manifest_digest,payload_digest,requested_by,state,dispatch_fence,expires_at,created_at,updated_at
         ) VALUES(?,?,?,'forget',?,?,?,?,'principal:owner','requested',0,?,?,?)`,
      ).run("memdel:v1:preserved", "corr:preserved", "idem:preserved",
        `sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`, "2026-08-31T00:10:00.000Z", "2026-08-31T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z");
      prior.db.prepare(
        `INSERT INTO memory_deletion_events(
          event_id,deletion_id,sequence,event_type,event_digest,created_at
         ) VALUES(?,?,1,'requested',?,?)`,
      ).run("memdel-event:v1:preserved", "memdel:v1:preserved", `sha256:${"e".repeat(64)}`,
        "2026-08-31T00:00:00.000Z");
      prior.db.prepare(
        `INSERT INTO memory_deletion_attempts(
          attempt_id,deletion_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at
         ) VALUES(?,?,1,?,'uncertain',?,?)`,
      ).run("memdel-attempt:v1:preserved", "memdel:v1:preserved", `sha256:${"f".repeat(64)}`,
        "2026-08-31T00:00:01.000Z", "2026-08-31T00:00:01.000Z");
      const before = laneRows(prior);
      cpSync(join(process.cwd(), "migrations", MIGRATION), join(priorMigrations, MIGRATION));
      await prior.migrate();
      expect(laneRows(prior)).toEqual(before);
      expect(prior.db.prepare("SELECT checksum FROM schema_migrations WHERE id=?").get(MIGRATION))
        .toEqual({ checksum: checksum(MIGRATION) });
      expect(prior.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memory_deletion_effect_transition'",
      ).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining("reconciling:conflict") }));
    } finally {
      prior.close();
      rmSync(join(priorMigrations, ".."), { recursive: true, force: true });
    }
  });

  it("upgrades an already migrated Core5 database without rewriting its journal", async () => {
    const pending = [MIGRATION, "098_morning_refresh_subscription.sql", "098_owner_decision_key_enrollment.sql"];
    const coreMigrations = migrationCopy(pending);
    const db = new AuthorityDb(tempDb(), coreMigrations);
    const coreIds = ["097_core5_integration_operations.sql", "098_core5_mail_draft_refs.sql"];
    const journal = (id: string) => db.db.prepare("SELECT id,checksum FROM schema_migrations WHERE id=?").get(id);
    try {
      await db.migrate();
      const before = coreIds.map(journal);
      expect(before).toEqual(coreIds.map(id => ({ id, checksum: checksum(id) })));
      for (const id of pending) {
        cpSync(join(process.cwd(), "migrations", id), join(coreMigrations, id));
      }
      await db.migrate();
      await db.assertMigrationsReady();
      expect(coreIds.map(journal)).toEqual(before);
      expect(pending.map(journal)).toEqual(pending.map(id => ({ id, checksum: checksum(id) })));
      expect(db.db.pragma("quick_check", { simple: true })).toBe("ok");
      expect(db.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
      rmSync(join(coreMigrations, ".."), { recursive: true, force: true });
    }
  });
});
