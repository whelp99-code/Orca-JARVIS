import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";
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
import { handshakeProvider, installProviderRelease, replayTombstoneGeneration } from "./personal-os-rehearsal-provider.js";
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
  if (scenario === "jm-server-offline") return jmServerOffline();
  if (scenario === "second-brain-offline") {
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
  const fixture = loadRehearsalFixture(options.fixturePath);
  const sourceRoot = options.sourceRoot ?? process.cwd();
  if (scenario === "second-brain-no-data" || scenario === "delete-sentinel" || scenario === "restore-tombstone") {
    const provider = installProviderRelease({ releaseRoot });
    if (scenario === "second-brain-no-data") {
      const hand = await handshakeProvider(provider);
      if (!hand.ok) throw new PersonalOsError("E_REHEARSAL_GATE");
      return {
        ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario, outcome: "no_data",
        unavailable: null, events: ZERO_EVENTS, live_path_mutation: false, current_after: provider.currentTarget,
      };
    }
    const replay = replayTombstoneGeneration({
      python: join(provider.venv, "bin/python"),
      shareRoot: join(releaseRoot, "provider-share"),
    });
    if (!replay.ok) throw new PersonalOsError("E_REHEARSAL_GATE");
    return {
      ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario,
      outcome: scenario === "delete-sentinel" ? "sentinel-absent" : "tombstone-replayed-before-activation",
      unavailable: null, events: { ...ZERO_EVENTS, deletion_leak: replay.deletion_leak },
      live_path_mutation: false, current_after: null,
    };
  }
  const dbPath = join(releaseRoot, "state/jarvis.sqlite");
  const anchors = join(releaseRoot, "anchors");
  await seedFixtureDatabase({
    dbPath, migrationsPath: join(sourceRoot, "migrations"), anchorDir: anchors, subject: fixture.subject,
  });
  if (scenario === "mac-disconnected") {
    const loop = await runFixtureLoop({ dbPath, artifactDir: join(releaseRoot, "artifacts"), anchorDir: anchors, at: times.at });
    if (!loop.ok || loop.mac_required !== false) throw new PersonalOsError("E_REHEARSAL_GATE");
    return {
      ok: true, rehearsal: "PERSONAL_OS_REHEARSAL_SCENARIO_OK", scenario, outcome: "loop-without-mac",
      unavailable: null, events: ZERO_EVENTS, live_path_mutation: false, current_after: null,
    };
  }
  if (scenario === "expired-passkey") {
    return expiredPasskey({ dbPath, anchorDir: anchors, policyPath: join(sourceRoot, "config/personal-os-policy.json"), at: times.at });
  }
  if (scenario === "crash-after-dispatch") return crashAfterDispatch(dbPath, times.at, anchors);
  if (scenario === "lost-memory-response") return lostMemoryResponse(dbPath, times.at, anchors);
  mkdirSync(join(releaseRoot, "releases", "e".repeat(40)), { recursive: true });
  activateCurrent(releaseRoot, "e".repeat(40));
  const digest = "a".repeat(64);
  pinProviderContract(releaseRoot, digest);
  const identity = { runtimeRoot: releaseRoot, dbPath, head: fixture.commit, tree: fixture.tree, providerDigest: digest };
  if (scenario === "schema-incompatible-rollback") return incompatibleRollback(identity);
  if (scenario === "rollback") return rollbackScenario({ ...identity, newerSha: "e".repeat(40) });
  throw new PersonalOsError("E_USAGE");
}
