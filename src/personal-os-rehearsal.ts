import { parseArgs } from "node:util";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";
import {
  REHEARSAL_SCENARIOS,
  parseRehearsalClock,
  type RehearsalOptions,
} from "./personal-os-rehearsal-contract.js";
import { runHappyRehearsal, type RehearsalResult } from "./personal-os-rehearsal-happy.js";
import { livePathsUnchanged, snapshotLivePaths } from "./personal-os-rehearsal-live-path.js";
import { runRehearsalScenario } from "./personal-os-rehearsal-scenario-run.js";
import { type ScenarioResult } from "./personal-os-rehearsal-scenarios.js";

export type { RehearsalOptions } from "./personal-os-rehearsal-contract.js";
export type { RehearsalResult } from "./personal-os-rehearsal-happy.js";

export async function runPersonalOsRehearsal(options: RehearsalOptions): Promise<RehearsalResult | ScenarioResult> {
  const releaseRoot = assertIsolatedRoot(options.releaseRoot);
  const times = parseRehearsalClock(options.clock);
  const before = snapshotLivePaths();
  const result = options.scenario === undefined
    ? await runHappyRehearsal(options, releaseRoot, times)
    : await runRehearsalScenario(options, releaseRoot, times);
  if (!livePathsUnchanged(before, snapshotLivePaths())) throw new PersonalOsError("E_REHEARSAL_GATE");
  return result;
}

export async function runPersonalOsRehearsalCli(argv: readonly string[]): Promise<void> {
  let values: { fixture?: string; clock?: string; "release-root"?: string; scenario?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        fixture: { type: "string" },
        clock: { type: "string" },
        "release-root": { type: "string" },
        scenario: { type: "string" },
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
  if (values.scenario !== undefined && !(REHEARSAL_SCENARIOS as readonly string[]).includes(values.scenario)) {
    throw new PersonalOsError("E_USAGE");
  }
  const result = await runPersonalOsRehearsal({
    fixturePath: values.fixture,
    clock: values.clock,
    releaseRoot: values["release-root"],
    ...(values.scenario === undefined ? {} : { scenario: values.scenario }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
