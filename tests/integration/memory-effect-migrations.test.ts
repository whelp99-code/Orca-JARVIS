import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { REJECTED_TASK30_MIGRATIONS } from "../fixtures/task30/rejected-migration-manifest.js";
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

function copyCurrentTask30Migrations(target: string): void {
  for (const name of readdirSync(join(process.cwd(), "migrations"))) {
    if (name >= "040_") cpSync(join(process.cwd(), "migrations", name), join(target, name));
  }
}

async function rejectedCandidate(prefixLength: number): Promise<{
  readonly databasePath: string;
  readonly migrations: string;
}> {
  const migrations = migrationRoot("039_memory_outbox_saga.sql");
  const databasePath = tempDb();
  const db = new AuthorityDb(databasePath, migrations);
  await db.migrate();
  for (const migration of REJECTED_TASK30_MIGRATIONS.slice(0, prefixLength)) {
    for (const table of migration.tables) db.db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
    db.db.prepare(
      "INSERT INTO schema_migrations(id,checksum,applied_at) VALUES(?,?,?)",
    ).run(migration.id, migration.checksum, "2026-08-31T00:00:00.000Z");
  }
  db.close();
  copyCurrentTask30Migrations(migrations);
  return { databasePath, migrations };
}

function task30Journal(db: AuthorityDb): readonly string[] {
  return (db.db.prepare(
    "SELECT id FROM schema_migrations WHERE id>='040_' ORDER BY id",
  ).all() as Array<{ readonly id: string }>).map(row => row.id);
}

const CURRENT_TASK30_MIGRATIONS = [
  "040_memory_tombstone_authority.sql",
  "041_memory_correction_saga.sql",
  "042_memory_deletion_proof.sql",
  "043_memory_export_saga.sql",
  "044_memory_content_propagation.sql",
  "045_task30_schema_compatibility.sql",
  "046_task30_legacy_guards.sql",
  "047_task30_confirmation_compatibility.sql",
] as const;

describe("Task 30 forward migration closure", () => {
  it("preserves the legacy lane while fresh and through-039 schemas converge", async () => {
    // Given: a through-039 database containing one historical legacy settlement.
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
    copyCurrentTask30Migrations(priorMigrations);
    const upgraded = new AuthorityDb(path, priorMigrations);
    const fresh = new AuthorityDb(tempDb());
    try {
      // When: immutable 040-044 and the additive compatibility migration are applied.
      await upgraded.migrate(); await fresh.migrate();
      // Then: schemas match, history remains in the legacy lane, and Task 30 starts empty.
      expect(schema(upgraded)).toEqual(schema(fresh));
      expect(upgraded.db.prepare(
        "SELECT state FROM memory_deletion_requests WHERE deletion_id='legacy-delete'",
      ).get()).toEqual({ state: "settled" });
      expect(upgraded.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_deletion_effect_requests WHERE deletion_id='legacy-delete'",
      ).get()).toEqual({ count: 0 });
      expect(upgraded.db.prepare(
        "SELECT prior_state,migrated_state FROM memory_deletion_legacy_audit WHERE deletion_id='legacy-delete'",
      ).get()).toEqual({ prior_state: "settled", migrated_state: "reconciling" });
      expect(task30Journal(upgraded)).toEqual(CURRENT_TASK30_MIGRATIONS);
    } finally {
      upgraded.close(); fresh.close(); rmSync(join(priorMigrations, ".."), { recursive: true, force: true });
    }
  });

  it.each([1, 2, 3, 4, 5])(
    "recovers an empty rejected-candidate prefix of length %i",
    async prefixLength => {
      // Given: an exact empty sequential prefix of the rejected Task 30 candidate.
      const fixture = await rejectedCandidate(prefixLength);
      const recovered = new AuthorityDb(fixture.databasePath, fixture.migrations);
      const fresh = new AuthorityDb(tempDb());
      try {
        // When: migration preflight recognizes and removes only that exact layout.
        await recovered.migrate(); await fresh.migrate();
        // Then: the current schema and journal are identical to a fresh database.
        expect(schema(recovered)).toEqual(schema(fresh));
        expect(task30Journal(recovered)).toEqual(CURRENT_TASK30_MIGRATIONS);
      } finally {
        recovered.close(); fresh.close();
        rmSync(join(fixture.migrations, ".."), { recursive: true, force: true });
      }
    },
  );

  it("rejects a rejected-candidate checksum or non-prefix without mutation", async () => {
    // Given: two independently invalid rejected-candidate journals.
    const checksumFixture = await rejectedCandidate(1);
    const layoutFixture = await rejectedCandidate(3);
    const checksumDb = new AuthorityDb(checksumFixture.databasePath, checksumFixture.migrations);
    const layoutDb = new AuthorityDb(layoutFixture.databasePath, layoutFixture.migrations);
    checksumDb.db.prepare(
      "UPDATE schema_migrations SET checksum=? WHERE id=?",
    ).run("0".repeat(64), REJECTED_TASK30_MIGRATIONS[0].id);
    layoutDb.db.prepare(
      "DELETE FROM schema_migrations WHERE id=?",
    ).run(REJECTED_TASK30_MIGRATIONS[1].id);
    const beforeChecksum = schema(checksumDb);
    const beforeLayout = schema(layoutDb);
    try {
      // When: migration preflight evaluates each invalid identity set.
      // Then: each fails with its closed code and does not apply current migrations.
      await expect(checksumDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
      await expect(layoutDb.migrate()).rejects.toMatchObject({ code: "MIGRATION_REJECTED_TASK30_LAYOUT_INVALID" });
      expect(schema(checksumDb)).toEqual(beforeChecksum);
      expect(schema(layoutDb)).toEqual(beforeLayout);
    } finally {
      checksumDb.close(); layoutDb.close();
      rmSync(join(checksumFixture.migrations, ".."), { recursive: true, force: true });
      rmSync(join(layoutFixture.migrations, ".."), { recursive: true, force: true });
    }
  });

  it("rejects effect-bearing rejected-candidate state without mutation", async () => {
    // Given: an exact rejected prefix containing one effect-bearing request row.
    const fixture = await rejectedCandidate(1);
    const db = new AuthorityDb(fixture.databasePath, fixture.migrations);
    db.db.prepare("INSERT INTO memory_effect_requests(id) VALUES(?)").run("effect:present");
    const before = schema(db);
    try {
      // When: recovery is attempted.
      // Then: authority-bearing state blocks automatic translation and remains untouched.
      await expect(db.migrate()).rejects.toMatchObject({ code: "MIGRATION_REJECTED_TASK30_DATA_PRESENT" });
      expect(schema(db)).toEqual(before);
      expect(task30Journal(db)).toEqual([REJECTED_TASK30_MIGRATIONS[0].id]);
    } finally {
      db.close(); rmSync(join(fixture.migrations, ".."), { recursive: true, force: true });
    }
  });
});
