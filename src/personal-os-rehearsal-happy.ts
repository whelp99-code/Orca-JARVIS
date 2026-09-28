import { join } from "node:path";
import { ProductionDatabaseLaneGuard, type ProductionDatabaseLane } from "./personal-os-production-db-lane.js";
import {
  CLIENT_QA_TARGETS,
  REHEARSAL_OK,
  ZERO_EVENTS,
  parseRehearsalClock,
  stageResult,
  type RehearsalEvents,
  type RehearsalOptions,
  type RehearsalStage,
} from "./personal-os-rehearsal-contract.js";
import { backupAndCheck, cloneDatabase, quickCheck, seedFixtureDatabase } from "./personal-os-rehearsal-database.js";
import { loadRehearsalFixture } from "./personal-os-rehearsal-fixture.js";
import { leaseGates, runIsolatedGates, runPackagedDoctor } from "./personal-os-rehearsal-gates.js";
import { runFixtureLoop } from "./personal-os-rehearsal-loop.js";
import { observeNoDataBoot } from "./personal-os-rehearsal-nodata.js";
import { handshakeProvider, installProviderRelease, replayTombstoneGeneration } from "./personal-os-rehearsal-provider.js";
import { migrateRehearsalSqlite } from "./personal-os-rehearsal-payload.js";
import { activateCurrent, assembleRehearsalRelease, placeRelease, writeReleaseReceipt } from "./personal-os-rehearsal-release.js";
import { rehearseRollbackBranch, restoreCurrent, vectorDigest } from "./personal-os-rehearsal-rollback.js";
import { renderIsolatedUnits } from "./personal-os-rehearsal-units.js";

export type RehearsalResult = {
  readonly ok: boolean;
  readonly rehearsal: typeof REHEARSAL_OK | "PERSONAL_OS_REHEARSAL_FAILED";
  readonly scope: "isolated_release_recovery";
  readonly deployment_ready: false;
  readonly runtime_validation: "performed";
  readonly production_activation: "skipped";
  readonly stages: readonly RehearsalStage[];
  readonly events: RehearsalEvents;
  readonly client_qa: typeof CLIENT_QA_TARGETS;
  readonly current_target: string | null;
  readonly payload_digest: string | null;
  readonly anchor_at: string;
  readonly virtual_at: string;
  readonly production_database: ProductionDatabaseLane;
  readonly live_path_mutation: false;
};

function failed(
  stages: readonly RehearsalStage[],
  times: ReturnType<typeof parseRehearsalClock>,
  production: ProductionDatabaseLane,
  current: string | null,
  digest: string | null,
): RehearsalResult {
  return {
    ok: false, rehearsal: "PERSONAL_OS_REHEARSAL_FAILED", scope: "isolated_release_recovery",
    deployment_ready: false, runtime_validation: "performed", production_activation: "skipped",
    stages, events: ZERO_EVENTS, client_qa: CLIENT_QA_TARGETS, current_target: current, payload_digest: digest,
    anchor_at: times.anchor_at, virtual_at: times.virtual_at, production_database: production, live_path_mutation: false,
  };
}

export async function runHappyRehearsal(
  options: RehearsalOptions,
  releaseRoot: string,
  times: ReturnType<typeof parseRehearsalClock>,
): Promise<RehearsalResult> {
  const fixture = loadRehearsalFixture(options.fixturePath);
  const sourceRoot = options.sourceRoot ?? process.cwd();
  const lane = new ProductionDatabaseLaneGuard();
  const stages: RehearsalStage[] = [];
  const assembled = assembleRehearsalRelease({
    stage: join(releaseRoot, "stage"), sourceRoot, sidecarDir: join(releaseRoot, "manifests"),
  });
  const placed = placeRelease({ stage: assembled.release, runtimeRoot: releaseRoot, sha: assembled.sha });
  const provider = installProviderRelease({ releaseRoot });
  const hand = await handshakeProvider(provider);
  stages.push(stageResult("mcp-handshake", hand.ok, hand));
  if (!hand.ok) return failed(stages, times, lane.receipt(), null, provider.payloadDigest);
  const noData = await observeNoDataBoot({
    cliPath: join(placed.release, "dist/src/cli.js"),
    install: provider,
    vaultRoot: join(releaseRoot, "provider-share/vault"),
  });
  stages.push(stageResult("no-data-boot", noData.data_state === "no_data" && noData.booted, noData));
  if (noData.data_state !== "no_data" || !noData.booted) {
    return failed(stages, times, lane.receipt(), null, provider.payloadDigest);
  }
  const baseline = join(releaseRoot, "state/fixture-generation/jarvis.sqlite");
  const clone = join(releaseRoot, "state/jarvis/jarvis.sqlite");
  lane.inspect(clone, "open");
  const seeded = await seedFixtureDatabase({
    dbPath: baseline, migrationsPath: join(placed.release, "migrations"),
    anchorDir: join(releaseRoot, "anchors"), subject: fixture.subject,
  });
  if (seeded.keyRows < 1) {
    stages.push(stageResult("fixture-seed", false, seeded));
    return failed(stages, times, lane.receipt(), null, null);
  }
  cloneDatabase(baseline, clone);
  const backup = await backupAndCheck(clone, join(releaseRoot, "state/backups/jarvis.sqlite"));
  const checked = quickCheck(clone);
  await migrateRehearsalSqlite({ dbPath: clone, migrationsPath: join(placed.release, "migrations") });
  stages.push(stageResult("cloned-db", checked === "ok" && backup.quick_check === "ok" && seeded.migrationRows > 1, {
    backup, quick_check: checked, migration_rows: seeded.migrationRows, fixture_subject: seeded.fixtureSubject,
  }));
  const units = renderIsolatedUnits({
    releaseRoot, dbPath: clone, providerCurrent: join(releaseRoot, "provider-releases/current"),
  });
  stages.push(stageResult("units", units.pointsAtCurrent && units.installed === false && units.liveUnit.applied === false, units));
  const current = activateCurrent(releaseRoot, assembled.sha);
  const vector = vectorDigest({ head: assembled.source.commit, tree: assembled.source.tree, dbPath: clone });
  writeReleaseReceipt({
    runtimeRoot: releaseRoot, sha: assembled.sha, manifestSha256: assembled.manifestSha256,
    payloadDigest: assembled.manifest.payload_digest, providerContractDigest: provider.payloadDigest,
    acceptedVectorDigests: [vector],
  });
  const doctor = runPackagedDoctor({
    cliPath: join(releaseRoot, "current/dist/src/cli.js"), dbPath: clone,
    launcher: provider.launcher, configPath: provider.configPath,
  });
  stages.push(stageResult("doctor", doctor.ok, doctor));
  const probed = await runIsolatedGates({
    dbPath: clone, staticRoot: join(releaseRoot, "dashboard-static"),
    launcher: provider.launcher, configPath: provider.configPath,
  });
  const health = probed.health;
  stages.push(stageResult("dashboard-health", health.ok, health));
  const gates = probed.gates;
  const lease = leaseGates(clone);
  stages.push(stageResult("gates", gates.ok && lease.quick_check === "ok" && lease.uncertain.ok === true, { gates, lease }));
  const loop = await runFixtureLoop({
    dbPath: clone, artifactDir: join(releaseRoot, "artifacts"), anchorDir: join(releaseRoot, "anchors"), at: times.at,
  });
  stages.push(stageResult("loop", loop.ok && loop.mac_required === false, loop));
  const replay = replayTombstoneGeneration({
    python: join(provider.venv, "bin/python"), shareRoot: join(releaseRoot, "provider-share"),
  });
  stages.push(stageResult("tombstone-restore", replay.ok, replay));
  const rollbackInput = {
    runtimeRoot: releaseRoot, dbPath: clone, head: assembled.source.commit,
    tree: assembled.source.tree, providerDigest: provider.payloadDigest,
  };
  const refused = rehearseRollbackBranch({ ...rollbackInput, targetSha: "c".repeat(40), accept: false });
  const allowed = rehearseRollbackBranch({ ...rollbackInput, targetSha: "b".repeat(40), accept: true });
  if (allowed.switched) restoreCurrent(releaseRoot, assembled.sha);
  stages.push(stageResult("rollback", refused.unavailable !== null && !refused.switched && allowed.switched, { refused, allowed }));
  const events: RehearsalEvents = { ...ZERO_EVENTS, deletion_leak: replay.deletion_leak };
  const passed = stages.every(item => item.ok) && events.deletion_leak === 0;
  return {
    ok: passed,
    rehearsal: passed ? REHEARSAL_OK : "PERSONAL_OS_REHEARSAL_FAILED",
    scope: "isolated_release_recovery",
    deployment_ready: false,
    runtime_validation: "performed",
    production_activation: "skipped",
    stages,
    events,
    client_qa: CLIENT_QA_TARGETS,
    current_target: current,
    payload_digest: assembled.manifest.payload_digest,
    anchor_at: times.anchor_at,
    virtual_at: times.virtual_at,
    production_database: lane.receipt(),
    live_path_mutation: false,
  };
}
