import { statSync } from "node:fs";
import type { CapabilityProbe } from "./capabilities.js";
import type { CliValues } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import {
  dashboardHealthGate,
  foreignKeyCheckGate,
  mcpHandshakeGate,
  runReleaseGates,
  schedulerCursorGate,
  type ReleaseGate,
} from "./release-health-gates.js";

export type ReleaseCommandDependencies = {
  readonly clock?: () => Date;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
};

const DB_GATE_KEYS = ["db", "json"] as const;

function assertExactOptions(values: CliValues, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(key)) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
  }
}

function assertExistingDatabase(path: string | undefined): string {
  if (path === undefined) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
  try {
    if (!statSync(path).isFile()) throw new Error();
  } catch {
    throw new JarvisError("RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
  return path;
}

function single(command: string, gate: ReleaseGate): Record<string, unknown> {
  return { ok: gate.ok, command, gate, ...(gate.ok ? {} : { exit_code: 1 }) };
}

/**
 * Health-gate commands answer from their own read-only connections and never migrate, so they run
 * before the shared authority handle is opened and before migration readiness is asserted — a gate
 * whose job is to report pending migrations cannot require them to be applied first.
 */
export async function executeReleaseGateCommand(
  positionals: readonly string[],
  values: CliValues,
  dependencies: ReleaseCommandDependencies = {},
): Promise<Record<string, unknown> | undefined> {
  const [command, subcommand] = positionals;
  if (command === "db" && subcommand === "foreign-key-check") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, DB_GATE_KEYS);
    return single("db.foreign-key-check", foreignKeyCheckGate(assertExistingDatabase(values.db)));
  }
  if (command !== "release") return undefined;
  if (subcommand === "scheduler-cursor") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, DB_GATE_KEYS);
    return single("release.scheduler-cursor", schedulerCursorGate(assertExistingDatabase(values.db)));
  }
  if (subcommand === "dashboard-health") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, ["json", "dashboard-url"]);
    return single("release.dashboard-health", await dashboardHealthGate({ url: values["dashboard-url"] }));
  }
  if (subcommand === "mcp-handshake") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, ["json"]);
    return single("release.mcp-handshake", await mcpHandshakeGate());
  }
  if (subcommand === "gates") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, ["db", "json", "dashboard-url"]);
    const report = await runReleaseGates({
      dbPath: assertExistingDatabase(values.db),
      now: dependencies.clock?.(),
      dashboardUrl: values["dashboard-url"],
      capabilityProbe: dependencies.capabilityProbe,
      secondBrainProbe: dependencies.secondBrainProbe,
    });
    return { ok: report.ok, command: "release.gates", report, ...(report.ok ? {} : { exit_code: 1 }) };
  }
  return undefined;
}
