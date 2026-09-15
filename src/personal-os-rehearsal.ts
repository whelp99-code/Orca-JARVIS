import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { backupSqlite, restoreSqlite } from "./personal-os-backup.js";
import {
  MIGRATION_VECTOR_CANONICAL_REF,
  decideRollback,
  migrationVectorDigest,
} from "./personal-os-compatibility.js";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";
import {
  type ProductionDatabaseLane,
  ProductionDatabaseLaneGuard,
} from "./personal-os-production-db-lane.js";
import { assertMigratedSchema, migrateRehearsalSqlite, writeRehearsalPayload } from "./personal-os-rehearsal-payload.js";
import { writeReleaseManifest } from "./personal-os-release-manifest.js";
import { publishRelease } from "./personal-os-release-publish.js";
import { PRODUCTION_ROOTS, renderSystemdUnit } from "./personal-os-systemd.js";
import Database from "better-sqlite3";

const HEX40 = /^[0-9a-f]{40}$/;
const FixtureSchema = z.object({
  schema_version: z.literal(1),
  scenario: z.string().min(1),
  commit: z.string().regex(HEX40),
  tree: z.string().regex(HEX40),
  first_parent: z.string().regex(HEX40),
  subject: z.string().min(1),
  commit_timestamp: z.string().min(1),
  provider_commit: z.string().regex(HEX40),
  provider_tree: z.string().regex(HEX40),
  provider_first_parent: z.string().regex(HEX40),
  provider_subject: z.string().min(1),
});

export type RehearsalOptions = {
  readonly fixturePath: string;
  readonly clock: string;
  readonly releaseRoot: string;
  readonly sourceRoot?: string;
};

const CLOCK = /^(\d{4}-\d{2}-\d{2})T07:15:00([+-]\d{2}:\d{2})$/;

function scenarioTimes(clock: string): { readonly anchor_at: string; readonly virtual_at: string } {
  const match = CLOCK.exec(clock);
  const date = match?.[1];
  const offset = match?.[2];
  if (date === undefined || offset === undefined) throw new PersonalOsError("E_CLOCK_INVALID");
  return {
    anchor_at: new Date(`${date}T07:15:00${offset}`).toISOString(),
    virtual_at: new Date(`${date}T06:55:00${offset}`).toISOString(),
  };
}

function migrationEntries(dbPath: string): readonly { readonly id: string; readonly sha256: string }[] {
  const db = openUnderSwapAdmission(dbPath,
    () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id").all() as Array<{
      readonly id: string;
      readonly sha256: string;
    }>;
  } finally {
    db.close();
  }
}

function assertOkGates(input: {
  readonly cliPath: string;
  readonly restorePath: string;
  readonly production: ProductionDatabaseLane;
}): void {
  const cli = readFileSync(input.cliPath, "utf8");
  if (cli.trim() === "export {};") throw new PersonalOsError("E_REHEARSAL_GATE");
  if (!cli.includes("execute")) throw new PersonalOsError("E_REHEARSAL_GATE");
  assertMigratedSchema(input.restorePath);
  if (input.production.open_attempts !== 0 || input.production.bytes_read !== 0 || input.production.copies_created !== 0) {
    throw new PersonalOsError("E_REHEARSAL_GATE");
  }
}

export type RehearsalResult = {
  readonly ok: true;
  readonly rehearsal: "PERSONAL_OS_REHEARSAL_OK";
  readonly scope: "fixture_backup_restore_and_release_pointer";
  readonly deployment_ready: false;
  readonly runtime_payload: "incomplete";
  readonly runtime_validation: "not_performed";
  readonly current_target: string;
  readonly payload_digest: string;
  readonly restore: { readonly destPath: string; readonly sha256: string; readonly bytes: number; readonly quick_check: string };
  readonly anchor_at: string;
  readonly virtual_at: string;
  readonly systemd_runtime: "SKIPPED_NOT_AUTHORIZED";
  readonly production_database: ProductionDatabaseLane;
};

export async function runPersonalOsRehearsal(options: RehearsalOptions): Promise<RehearsalResult> {
  const releaseRoot = assertIsolatedRoot(options.releaseRoot);
  const sourceRoot = options.sourceRoot ?? process.cwd();
  const times = scenarioTimes(options.clock);
  const lane = new ProductionDatabaseLaneGuard();
  let fixture: z.infer<typeof FixtureSchema>;
  try {
    fixture = FixtureSchema.parse(JSON.parse(readFileSync(options.fixturePath, "utf8")));
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_FIXTURE_INVALID");
  }
  const stage = join(releaseRoot, "stage");
  writeRehearsalPayload({ stage, sourceRoot });
  const written = writeReleaseManifest({
    root: stage,
    artifact: "jarvis-authority",
    source: {
      commit: fixture.commit,
      tree: fixture.tree,
      first_parent: fixture.first_parent,
      subject: fixture.subject,
      commit_timestamp: fixture.commit_timestamp,
      archive_digest: fixture.tree + fixture.tree.slice(0, 24),
    },
    build: {
      source_date_epoch: 0,
      builder_command: "personal-os-rehearsal",
      offline_cache_digest: "e".repeat(64),
      lifecycle_command_digests: ["f".repeat(64)],
      reproducibility_receipt: "g".repeat(64),
    },
    sidecarDir: join(releaseRoot, "manifests"),
  });
  const published = publishRelease({ stage, runtimeRoot: releaseRoot, sha: fixture.commit });
  const dbPath = join(releaseRoot, "state/jarvis/jarvis.sqlite");
  const backupPath = join(releaseRoot, "state/backups/jarvis.sqlite");
  const restorePath = join(releaseRoot, "state/restore/jarvis.sqlite");
  lane.inspect(dbPath, "open");
  lane.inspect(backupPath, "copy");
  lane.inspect(restorePath, "copy");
  await migrateRehearsalSqlite({
    dbPath,
    migrationsPath: join(published.release, "migrations"),
  });
  const backup = await backupSqlite({ sourcePath: dbPath, destPath: backupPath });
  const restore = restoreSqlite({ backupPath: backup.destPath, destPath: restorePath });
  const production_database = lane.receipt();
  assertOkGates({
    cliPath: join(published.release, "dist/src/cli.js"),
    restorePath: restore.destPath,
    production: production_database,
  });
  const fixtureRoots = {
    authorityCurrent: join(releaseRoot, "current"),
    jarvisDb: dbPath,
    backupRoot: join(releaseRoot, "state/backups"),
    providerCurrent: join(releaseRoot, "provider-releases/current"),
    providerState: join(releaseRoot, "state/provider"),
  };
  mkdirSync(join(releaseRoot, "units"), { recursive: true });
  writeFileSync(join(releaseRoot, "units/jm-jarvis.service"), renderSystemdUnit({
    id: "jm-jarvis.service",
    mode: "fixture",
    roots: fixtureRoots,
  }));
  const vector = migrationVectorDigest({
    canonical_ref: MIGRATION_VECTOR_CANONICAL_REF,
    head: fixture.commit,
    tree: fixture.tree,
    migrations: migrationEntries(restore.destPath),
  });
  const rollback = decideRollback({
    currentVectorDigest: vector,
    targetAcceptedDigests: [vector],
    providerContractMatch: true,
    sealedManifestMatch: true,
  });
  const handoff = {
    schema_version: 1,
    rehearsal: "PERSONAL_OS_REHEARSAL_OK",
    scope: "fixture_backup_restore_and_release_pointer",
    deployment_ready: false,
    runtime_payload: "incomplete",
    runtime_validation: "not_performed",
    linux_authority: true,
    mac_client_only: true,
    jarvis_rpo_15m: true,
    provider_rpo_25h: true,
    systemd_runtime: "SKIPPED_NOT_AUTHORIZED",
    production_activation_gate: "JARVIS_PRODUCTION_ACTIVATION_APPROVAL",
    rollback,
    payload_digest: written.manifest.payload_digest,
    production_unit_sample: renderSystemdUnit({
      id: "jm-jarvis-backup.timer",
      mode: "production",
      roots: PRODUCTION_ROOTS,
    }).includes("OnCalendar=*:0/15"),
  };
  mkdirSync(join(releaseRoot, "handoff"), { recursive: true });
  writeFileSync(join(releaseRoot, "handoff/operator-handoff.json"), `${JSON.stringify(handoff)}\n`);
  return {
    ok: true,
    rehearsal: "PERSONAL_OS_REHEARSAL_OK",
    scope: "fixture_backup_restore_and_release_pointer",
    deployment_ready: false,
    runtime_payload: "incomplete",
    runtime_validation: "not_performed",
    current_target: published.currentTarget,
    payload_digest: written.manifest.payload_digest,
    restore,
    anchor_at: times.anchor_at,
    virtual_at: times.virtual_at,
    systemd_runtime: "SKIPPED_NOT_AUTHORIZED",
    production_database,
  };
}

export async function runPersonalOsRehearsalCli(argv: readonly string[]): Promise<void> {
  let values: { fixture?: string; clock?: string; "release-root"?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        fixture: { type: "string" },
        clock: { type: "string" },
        "release-root": { type: "string" },
        json: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch {
    throw new PersonalOsError("E_USAGE");
  }
  if (values.fixture === undefined || values.clock === undefined || values["release-root"] === undefined) {
    throw new PersonalOsError("E_USAGE");
  }
  const result = await runPersonalOsRehearsal({
    fixturePath: values.fixture,
    clock: values.clock,
    releaseRoot: values["release-root"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
