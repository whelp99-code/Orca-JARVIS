import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PersonalOsError, assertNever } from "./personal-os-errors.js";
import {
  ZERO_EVENTS,
  isRehearsalScenario,
  parseRehearsalClock,
  unavailable,
  type RehearsalOptions,
} from "./personal-os-rehearsal-contract.js";
import { seedFixtureDatabase } from "./personal-os-rehearsal-database.js";
import { loadRehearsalFixture } from "./personal-os-rehearsal-fixture.js";
import { runFixtureLoop } from "./personal-os-rehearsal-loop.js";
import { observeNoDataBoot } from "./personal-os-rehearsal-nodata.js";
import { installProviderRelease, replayTombstoneGeneration, type ProviderInstall } from "./personal-os-rehearsal-provider.js";
import { activateCurrent } from "./personal-os-rehearsal-release.js";
import { pinProviderContract } from "./personal-os-rehearsal-rollback.js";
import {
  crashAfterDispatch,
  expiredPasskey,
  incompatibleRollback,
  jmServerOffline,
  lostMemoryResponse,
  rollbackScenario,
  type ScenarioResult,
} from "./personal-os-rehearsal-scenarios.js";
import { mcpHandshakeGate } from "./release-health-gates.js";

export async function runRehearsalScenario(
  options: RehearsalOptions,
  releaseRoot: string,
  times: ReturnType<typeof parseRehearsalClock>,
): Promise<ScenarioResult> {
  const scenario = options.scenario;
  if (scenario === undefined || !isRehearsalScenario(scenario)) throw new PersonalOsError("E_USAGE");
  switch (scenario) {
    case "jm-server-offline":
      return jmServerOffline();
    case "second-brain-offline":
      return offlineLauncher(releaseRoot, scenario);
    case "second-brain-no-data":
      return emptyVault(releaseRoot);
    case "delete-sentinel":
      return tombstoneReplay(releaseRoot, scenario, "sentinel-absent");
    case "restore-tombstone":
      return tombstoneReplay(releaseRoot, scenario, "tombstone-replayed-before-activation");
    case "mac-disconnected":
      return macDisconnected(options, releaseRoot, times, scenario);
    case "expired-passkey":
      return seeded(options, releaseRoot, times, (dbPath, anchors, sourceRoot) => expiredPasskey({
        dbPath, anchorDir: anchors, policyPath: join(sourceRoot, "config/personal-os-policy.json"), at: times.at,
      }));
    case "crash-after-dispatch":
      return seeded(options, releaseRoot, times, (dbPath, anchors) => crashAfterDispatch(dbPath, times.at, anchors));
    case "lost-memory-response":
      return seeded(options, releaseRoot, times, (dbPath, anchors) => lostMemoryResponse(dbPath, times.at, anchors));
    case "schema-incompatible-rollback":
      return seeded(options, releaseRoot, times, (dbPath, _anchors, _source, fixture) => {
        const identity = pinCurrent(releaseRoot, dbPath, fixture);
        return incompatibleRollback(identity);
      });
    case "rollback":
      return seeded(options, releaseRoot, times, (dbPath, _anchors, _source, fixture) => {
        const identity = pinCurrent(releaseRoot, dbPath, fixture);
        return rollbackScenario({ ...identity, newerSha: "e".repeat(40) });
      });
    default:
      return assertNever(scenario);
  }
}

async function offlineLauncher(releaseRoot: string, scenario: "second-brain-offline"): Promise<ScenarioResult> {
  const gate = await mcpHandshakeGate({
    launcherPath: join(releaseRoot, "missing-launcher"),
    configPath: join(releaseRoot, "missing.toml"),
  });
  if (gate.ok) throw new PersonalOsError("E_REHEARSAL_GATE");
  return {
    ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario, outcome: "unavailable",
    unavailable: unavailable("second_brain", gate.code ?? "SECOND_BRAIN_HANDSHAKE_FAILED"),
    events: ZERO_EVENTS, live_path_mutation: false, current_after: null,
  };
}

export async function finishNoDataScenario(install: ProviderInstall): Promise<ScenarioResult> {
  const observed = await observeNoDataBoot({ install });
  if (observed.data_state !== "no_data" || observed.page_count !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  return {
    ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario: "second-brain-no-data",
    outcome: observed.data_state,
    unavailable: null, events: ZERO_EVENTS, live_path_mutation: false, current_after: install.currentTarget,
  };
}

async function emptyVault(releaseRoot: string): Promise<ScenarioResult> {
  return finishNoDataScenario(installProviderRelease({ releaseRoot }));
}

async function tombstoneReplay(
  releaseRoot: string,
  scenario: "delete-sentinel" | "restore-tombstone",
  outcome: string,
): Promise<ScenarioResult> {
  const provider = installProviderRelease({ releaseRoot });
  const replay = replayTombstoneGeneration({
    python: join(provider.venv, "bin/python"),
    shareRoot: join(releaseRoot, "provider-share"),
  });
  if (!replay.ok) throw new PersonalOsError("E_REHEARSAL_GATE");
  return {
    ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario, outcome,
    unavailable: null, events: { ...ZERO_EVENTS, deletion_leak: replay.deletion_leak },
    live_path_mutation: false, current_after: null,
  };
}

async function macDisconnected(
  options: RehearsalOptions,
  releaseRoot: string,
  times: ReturnType<typeof parseRehearsalClock>,
  scenario: "mac-disconnected",
): Promise<ScenarioResult> {
  return seeded(options, releaseRoot, times, async (dbPath, anchors) => {
    const loop = await runFixtureLoop({
      dbPath, artifactDir: join(releaseRoot, "artifacts"), anchorDir: anchors, at: times.at,
    });
    if (!loop.ok || loop.mac_required !== false) throw new PersonalOsError("E_REHEARSAL_GATE");
    return {
      ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario, outcome: "loop-without-mac",
      unavailable: null, events: ZERO_EVENTS, live_path_mutation: false, current_after: null,
    };
  });
}

function pinCurrent(releaseRoot: string, dbPath: string, fixture: { readonly commit: string; readonly tree: string }) {
  mkdirSync(join(releaseRoot, "releases", "e".repeat(40)), { recursive: true });
  activateCurrent(releaseRoot, "e".repeat(40));
  const digest = "a".repeat(64);
  pinProviderContract(releaseRoot, digest);
  return { runtimeRoot: releaseRoot, dbPath, head: fixture.commit, tree: fixture.tree, providerDigest: digest };
}

async function seeded(
  options: RehearsalOptions,
  releaseRoot: string,
  times: ReturnType<typeof parseRehearsalClock>,
  run: (
    dbPath: string,
    anchors: string,
    sourceRoot: string,
    fixture: ReturnType<typeof loadRehearsalFixture>,
  ) => Promise<ScenarioResult> | ScenarioResult,
): Promise<ScenarioResult> {
  const fixture = loadRehearsalFixture(options.fixturePath);
  const sourceRoot = options.sourceRoot ?? process.cwd();
  const dbPath = join(releaseRoot, "state/jarvis.sqlite");
  const anchors = join(releaseRoot, "anchors");
  await seedFixtureDatabase({
    dbPath, migrationsPath: join(sourceRoot, "migrations"), anchorDir: anchors, subject: fixture.subject,
  });
  return run(dbPath, anchors, sourceRoot, fixture);
}
