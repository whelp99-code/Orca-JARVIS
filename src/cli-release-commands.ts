import { statSync } from "node:fs";
import type { CapabilityProbe } from "./capabilities.js";
import type { CliValues } from "./cli-command-context.js";
import { JarvisError } from "./db.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import {
  DEFAULT_RELEASE_PHASE,
  RELEASE_PHASES,
  dashboardHealthGate,
  foreignKeyCheckGate,
  mcpHandshakeGate,
  runReleaseGates,
  schedulerCursorGate,
  type ReleaseGate,
  type ReleasePhase,
} from "./release-health-gates.js";
import { runMigrationRehearsal } from "./release-migration-rehearsal.js";
import { runReleaseRollback } from "./release-rollback.js";
import { runReleaseRestore } from "./release-restore.js";

export type ReleaseCommandDependencies = {
  readonly clock?: () => Date;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
};

const DB_GATE_KEYS = ["db", "json"] as const;

function assertExactOptions(
  values: CliValues,
  allowed: readonly string[],
  code = "RELEASE_GATE_INPUT_INVALID",
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(key)) throw new JarvisError(code);
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

function releasePhase(value: string | undefined): ReleasePhase {
  if (value === undefined) return DEFAULT_RELEASE_PHASE;
  const found = RELEASE_PHASES.find(phase => phase === value);
  if (found === undefined) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
  return found;
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
  if (command === "db" && subcommand === "migrate" && values.rehearse !== undefined) {
    if (positionals.length !== 2) throw new JarvisError("MIGRATION_REHEARSAL_INPUT_INVALID");
    assertExactOptions(values, ["rehearse", "json", "rehearsal-receipt"], "MIGRATION_REHEARSAL_INPUT_INVALID");
    const result = await runMigrationRehearsal({
      sourcePath: values.rehearse,
      receiptPath: values["rehearsal-receipt"],
      now: dependencies.clock?.(),
    });
    return { command: "db.migrate.rehearse", ...result, ...(result.ok ? {} : { exit_code: 1 }) };
  }
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
  if (subcommand === "rollback") {
    if (positionals.length !== 2 || values.to === undefined || values["release-root"] === undefined) {
      throw new JarvisError("RELEASE_ROLLBACK_INPUT_INVALID");
    }
    assertExactOptions(values,
      ["db", "json", "to", "release-root", "dry-run", "production-root", "restore-backup"],
      "RELEASE_ROLLBACK_INPUT_INVALID");
    // The restore form is the documented recovery for a target the three qualification checks
    // cannot pass, so it answers on the backup's vector instead of on them.
    if (values["restore-backup"] !== undefined) {
      const restored = runReleaseRestore({
        releaseRoot: values["release-root"],
        dbPath: assertExistingDatabase(values.db),
        to: values.to,
        backupPath: values["restore-backup"],
        dryRun: values["dry-run"] === true,
        productionRoot: values["production-root"] === true,
        now: dependencies.clock?.(),
      });
      return { ok: true, command: "release.rollback", ...restored };
    }
    const result = runReleaseRollback({
      releaseRoot: values["release-root"],
      dbPath: assertExistingDatabase(values.db),
      to: values.to,
      dryRun: values["dry-run"] === true,
      productionRoot: values["production-root"] === true,
    });
    return { ok: true, command: "release.rollback", ...result };
  }
  if (subcommand === "gates") {
    if (positionals.length !== 2) throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    assertExactOptions(values, ["db", "json", "dashboard-url", "phase", "rehearsal-receipt"]);
    const phase = releasePhase(values.phase);
    // A rehearsal receipt licenses only a pre-activation vector; offering one post-activation is a
    // misunderstanding of what is being gated, not an input the gate quietly ignores.
    if (values["rehearsal-receipt"] !== undefined && phase !== "pre-activation") {
      throw new JarvisError("RELEASE_GATE_INPUT_INVALID");
    }
    const report = await runReleaseGates({
      dbPath: assertExistingDatabase(values.db),
      phase,
      rehearsalReceiptPath: values["rehearsal-receipt"],
      now: dependencies.clock?.(),
      dashboardUrl: values["dashboard-url"],
      capabilityProbe: dependencies.capabilityProbe,
      secondBrainProbe: dependencies.secondBrainProbe,
    });
    return { ok: report.ok, command: "release.gates", report, ...(report.ok ? {} : { exit_code: 1 }) };
  }
  return undefined;
}
