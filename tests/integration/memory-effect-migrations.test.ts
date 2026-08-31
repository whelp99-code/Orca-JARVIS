import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

function migrationRoot(through: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-task30-migrations-"));
  const migrations = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
  for (const name of readdirSync(migrations)) if (name > through) rmSync(join(migrations, name));
  return migrations;
}
function schema(db: AuthorityDb): unknown {
  return db.db.prepare(
    `SELECT type,name,tbl_name,sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
  ).all();
}

describe("Task 30 forward migration closure", () => {
  it("matches fresh schema from 039 and reopens legacy settlement as reconciling", async () => {
    const priorMigrations = migrationRoot("039_memory_outbox_saga.sql");
    const path = tempDb();
    const prior = new AuthorityDb(path, priorMigrations);
    await prior.migrate();
    prior.db.prepare(
      `INSERT INTO memory_deletion_requests(
        deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,
        target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at
       ) VALUES('legacy-delete','legacy-correlation','legacy-idempotency','forget',?,?,?,?,'local-owner',
        'requested',0,'2026-09-01T00:00:00.000Z','2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z')`,
    ).run(...Array.from({ length: 4 }, () => `sha256:${"1".repeat(64)}`));
    prior.db.exec(`DROP TRIGGER memory_deletion_transition;
      DROP TRIGGER memory_deletion_current_lease_guard;
      DROP TRIGGER memory_deletion_tombstone_guard;`);
    prior.db.prepare("UPDATE memory_deletion_requests SET state='settled' WHERE deletion_id='legacy-delete'").run();
    prior.close();
    for (const name of readdirSync(join(process.cwd(), "migrations"))) {
      if (name >= "040_") cpSync(join(process.cwd(), "migrations", name), join(priorMigrations, name));
    }
    const upgraded = new AuthorityDb(path, priorMigrations);
    const fresh = new AuthorityDb(tempDb());
    try {
      await upgraded.migrate(); await fresh.migrate();
      expect(schema(upgraded)).toEqual(schema(fresh));
      expect(upgraded.db.prepare(
        "SELECT state,failure_code FROM memory_deletion_requests WHERE deletion_id='legacy-delete'",
      ).get()).toEqual({ state: "reconciling", failure_code: "REAPPROVAL_REQUIRED" });
      expect(upgraded.db.prepare(
        "SELECT prior_state,migrated_state FROM memory_deletion_legacy_audit WHERE deletion_id='legacy-delete'",
      ).get()).toEqual({ prior_state: "settled", migrated_state: "reconciling" });
    } finally {
      upgraded.close(); fresh.close(); rmSync(join(priorMigrations, ".."), { recursive: true, force: true });
    }
  });
});
