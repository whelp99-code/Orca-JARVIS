import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";
import {
  type GeneratedUnitId,
  UNIT_INVENTORY,
  renderSystemdUnit,
} from "./personal-os-systemd.js";

export const CONFIG_ARTIFACTS = [
  "config/personal-os-policy.json",
  "config/personal-os-runtime.schema.json",
  "config/backup-policy.json",
  "config/release-compatibility.schema.json",
  "config/dashboard-runtime.schema.json",
  "config/phone-gateway.env.schema.json",
  "config/remote-approval.env.schema.json",
] as const;

const ATTEMPT_MARKERS = ["/dev/shm", "/Volumes/DevSpace"] as const;
const PRODUCTION_MARKERS = [
  "/home/jm/.local/state/orca-jarvis",
  "/home/jm/.local/state/second-brain",
] as const;

export type NativeAnalyzeResult = {
  readonly command: readonly string[];
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type SystemdVerifyReceipt = {
  readonly schema_version: 1;
  readonly production_units_missing: number;
  readonly fixture_units_missing: number;
  readonly config_artifacts_missing: number;
  readonly native_verify_exit: number;
  readonly production_attempt_paths: number;
  readonly fixture_production_paths: number;
  readonly node_version: string;
  readonly node_abi: string;
  readonly SYSTEMD_RUNTIME_EXECUTED: 0;
  readonly SYSTEMD_RUNTIME_STATE: "SKIPPED_NOT_AUTHORIZED";
  readonly production_command: readonly string[];
  readonly fixture_command: readonly string[];
  readonly production_log: string;
  readonly fixture_log: string;
};

function inventoryIds(): readonly string[] {
  return [...UNIT_INVENTORY.jarvis, ...UNIT_INVENTORY.provider];
}

function isGeneratedUnitId(id: string): id is GeneratedUnitId {
  switch (id) {
    case "jm-jarvis.service":
    case "jm-jarvis-backup.service":
    case "jm-jarvis-backup.timer":
    case "jm-second-brain-backup.service":
    case "jm-second-brain-backup.timer":
    case "jm-second-brain-requests.service":
    case "jm-second-brain-requests.path":
      return true;
    default:
      return false;
  }
}

function countMarkers(text: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => count + (text.includes(marker) ? 1 : 0), 0);
}

function fixtureText(productionText: string, fixturePathRoot: string): string {
  return productionText
    .replaceAll("/home/jm/.local/state/orca-jarvis", `${fixturePathRoot}/orca-jarvis`)
    .replaceAll("/home/jm/.local/state/second-brain", `${fixturePathRoot}/second-brain`);
}

export function nativeSystemdAnalyzeVerify(unitPaths: readonly string[]): NativeAnalyzeResult {
  const command = ["systemd-analyze", "verify", "--man=no", ...unitPaths] as const;
  const result = spawnSync("systemd-analyze", ["verify", "--man=no", ...unitPaths], {
    encoding: "utf8",
    env: { ...process.env, SYSTEMD_COLORS: "0" },
  });
  if (result.error !== undefined) throw new PersonalOsError("E_SYSTEMD_VERIFY");
  return {
    command,
    exit: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function runNativeSystemdVerify(input: {
  readonly worktree: string;
  readonly isolatedRoot: string;
}): SystemdVerifyReceipt {
  const isolatedRoot = assertIsolatedRoot(input.isolatedRoot);
  const ids = inventoryIds();
  const productionPaths = ids.map((id) => join(input.worktree, "deploy", id));
  const production_units_missing = productionPaths.filter((path) => !existsSync(path)).length;
  const config_artifacts_missing = CONFIG_ARTIFACTS.filter((rel) => !existsSync(join(input.worktree, rel))).length;
  if (production_units_missing !== 0 || config_artifacts_missing !== 0) {
    throw new PersonalOsError("E_SYSTEMD_VERIFY");
  }
  const unitsDir = join(isolatedRoot, "units");
  mkdirSync(unitsDir, { recursive: true });
  const fixturePathRoot = join(input.worktree, "test/fixtures/personal-os/runtime-root");
  const fixtureRoots = {
    authorityCurrent: join(fixturePathRoot, "authority/current"),
    jarvisDb: join(fixturePathRoot, "jarvis.sqlite"),
    backupRoot: join(fixturePathRoot, "backups"),
    providerCurrent: join(fixturePathRoot, "provider/current"),
    providerState: join(fixturePathRoot, "provider"),
  };
  const fixturePaths: string[] = [];
  let fixture_production_paths = 0;
  let production_attempt_paths = 0;
  for (const id of ids) {
    const productionPath = join(input.worktree, "deploy", id);
    const productionText = readFileSync(productionPath, "utf8");
    production_attempt_paths += countMarkers(productionText, ATTEMPT_MARKERS);
    const rendered = isGeneratedUnitId(id)
      ? renderSystemdUnit({ id, mode: "fixture", roots: fixtureRoots })
      : fixtureText(productionText, fixturePathRoot);
    fixture_production_paths += countMarkers(rendered, PRODUCTION_MARKERS);
    const fixturePath = join(unitsDir, id);
    writeFileSync(fixturePath, rendered);
    fixturePaths.push(fixturePath);
  }
  const fixture_units_missing = fixturePaths.filter((path) => !existsSync(path)).length;
  const production = nativeSystemdAnalyzeVerify(productionPaths);
  const fixture = nativeSystemdAnalyzeVerify(fixturePaths);
  const native_verify_exit = production.exit !== 0 ? production.exit : fixture.exit;
  return {
    schema_version: 1,
    production_units_missing,
    fixture_units_missing,
    config_artifacts_missing,
    native_verify_exit,
    production_attempt_paths,
    fixture_production_paths,
    node_version: process.versions.node,
    node_abi: process.versions.modules,
    SYSTEMD_RUNTIME_EXECUTED: 0,
    SYSTEMD_RUNTIME_STATE: "SKIPPED_NOT_AUTHORIZED",
    production_command: production.command,
    fixture_command: fixture.command,
    production_log: `${production.stdout}${production.stderr}`,
    fixture_log: `${fixture.stdout}${fixture.stderr}`,
  };
}
