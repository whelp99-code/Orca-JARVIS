import { describe, expect, it } from "vitest";
import { productionBackupRoot, productionBackupSource } from "../../src/personal-os-backup.js";
import {
  DEPLOYMENT_ROOT_VARIABLES,
  resolveDeploymentRoots,
} from "../../src/personal-os-deployment-roots.js";
import { productionDatabasePaths } from "../../src/personal-os-production-db-lane.js";
import { protectedRoots } from "../../src/personal-os-protected-paths.js";
import { secondBrainConfig, secondBrainLauncher } from "../../src/second-brain-transport-contract.js";

const SERVICE_ENVIRONMENT = {
  JARVIS_STATE_ROOT: "/var/lib/jarvis-svc/state/orca-jarvis",
  JARVIS_PROVIDER_STATE_ROOT: "/var/lib/jarvis-svc/state/second-brain",
  JARVIS_PROVIDER_CONFIG: "/var/lib/jarvis-svc/config/second-brain/config.toml",
  JARVIS_PROVIDER_SHARE_ROOT: "/var/lib/jarvis-svc/share/second-brain",
  JARVIS_SHARE_ROOT: "/var/lib/jarvis-svc/share/jarvis",
  JARVIS_CONFIG_ROOT: "/var/lib/jarvis-svc/config",
  JARVIS_BIN_ROOT: "/opt/jarvis-runtime/bin",
  JARVIS_NODE_BIN: "/opt/jarvis-runtime/bin/node",
  JARVIS_SERVICE_USER: "jarvis-svc",
} as const;

describe("deployment roots", () => {
  it("keeps the /home/jm deployment when no variable is set", () => {
    // Given / When
    const roots = resolveDeploymentRoots({});

    // Then
    expect(roots).toMatchObject({
      stateRoot: "/home/jm/.local/state/orca-jarvis",
      jarvisDb: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
      backupRoot: "/home/jm/.local/state/orca-jarvis/backups",
      authorityCurrent: "/home/jm/.local/state/orca-jarvis/authority/current",
      controlCenterCurrent: "/home/jm/.local/state/orca-jarvis/control-center/current",
      providerStateRoot: "/home/jm/.local/state/second-brain",
      providerCurrent: "/home/jm/.local/state/second-brain/app/current",
      providerLauncher: "/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp",
      providerCli: "/home/jm/.local/state/second-brain/app/current/bin/sb",
      providerConfig: "/home/jm/.config/second-brain/config.toml",
      providerMarker: "/home/jm/.config/second-brain/request-executor.enabled",
      providerShareRoot: "/home/jm/.local/share/second-brain",
      authorityShareRoot: "/home/jm/.local/share/jarvis",
      configRoot: "/home/jm/.config",
      nodeBin: "/home/jm/.nvm/versions/node/v24.19.0/bin/node",
      serviceUser: undefined,
    });
    expect(Object.keys(DEPLOYMENT_ROOT_VARIABLES)).toContain("stateRoot");
  });

  // Gap G3 of the cutover: the task executor was pinned by absolute path inside the interactive
  // user's 0750 home, so a nologin service account could never reach it and the runbook had to
  // omit the variable entirely. The executor is now a deployment root with a bin-root default.
  it("defaults the task executor under the bin root exactly when a service account is configured", () => {
    // Given / When / Then
    // An unconfigured per-user installation gets no default: its executor is whatever its own
    // drop-in already says, and inventing a path here would change a running installation.
    expect(resolveDeploymentRoots({}).taskClaudePath).toBeUndefined();
    // A configured deployment reaches the executor through the same world-readable bin root its
    // unit PATH already names, not through the user's home.
    expect(resolveDeploymentRoots(SERVICE_ENVIRONMENT).taskClaudePath).toBe("/opt/jarvis-runtime/bin/claude");
    // An explicit path always wins, including for the per-user installation.
    expect(resolveDeploymentRoots({ JARVIS_TASK_CLAUDE_PATH: "/opt/other/claude" }).taskClaudePath)
      .toBe("/opt/other/claude");
    expect(resolveDeploymentRoots({ ...SERVICE_ENVIRONMENT, JARVIS_TASK_CLAUDE_PATH: "/opt/other/claude" })
      .taskClaudePath).toBe("/opt/other/claude");
    // Empty means unconfigured here, exactly as the executor registry already reads it.
    expect(resolveDeploymentRoots({ ...SERVICE_ENVIRONMENT, JARVIS_TASK_CLAUDE_PATH: "" }).taskClaudePath)
      .toBe("/opt/jarvis-runtime/bin/claude");
    // A named executor is still a path, held to the same rules as every other root.
    for (const value of ["relative/claude", "/opt/./claude", "/opt/../opt/claude"]) {
      expect(() => resolveDeploymentRoots({ JARVIS_TASK_CLAUDE_PATH: value })).toThrow("E_DEPLOYMENT_ROOT");
    }
    expect(Object.keys(DEPLOYMENT_ROOT_VARIABLES)).toContain("taskClaudePath");
  });

  it("moves every derived path when the service-user variables are set", () => {
    // Given / When
    const roots = resolveDeploymentRoots(SERVICE_ENVIRONMENT);

    // Then
    expect(Object.values(roots).filter(value => typeof value === "string")
      .filter(value => value.startsWith("/home/jm"))).toEqual([]);
    expect(roots.jarvisDb).toBe("/var/lib/jarvis-svc/state/orca-jarvis/jarvis.sqlite");
    expect(roots.providerMarker).toBe("/var/lib/jarvis-svc/config/second-brain/request-executor.enabled");
    expect(roots.serviceUser).toBe("jarvis-svc");
  });

  it("refuses an override that is not an already-canonical absolute path", () => {
    // Given / When / Then
    for (const value of ["", "state/orca-jarvis", "/var/lib/jarvis-svc/state/", "/var/lib/./jarvis-svc"]) {
      expect(() => resolveDeploymentRoots({ JARVIS_STATE_ROOT: value })).toThrow("E_DEPLOYMENT_ROOT");
    }
    expect(() => resolveDeploymentRoots({ JARVIS_SERVICE_USER: "Jarvis Svc" })).toThrow("E_DEPLOYMENT_ROOT");
  });

  it("follows the configured roots in the protected-path, production-db and backup contracts", () => {
    // Given / When
    const roots = resolveDeploymentRoots(SERVICE_ENVIRONMENT);

    // Then
    expect(protectedRoots(SERVICE_ENVIRONMENT)).toEqual([
      roots.stateRoot, roots.providerStateRoot, roots.providerShareRoot, roots.authorityShareRoot,
      `${roots.configRoot}/systemd`, "/var/lib/jarvis-svc/config/second-brain", `${roots.configRoot}/orca-jarvis`,
    ]);
    expect(productionDatabasePaths(SERVICE_ENVIRONMENT)).toEqual([roots.jarvisDb]);
    expect(productionBackupSource(SERVICE_ENVIRONMENT)).toBe(roots.jarvisDb);
    expect(productionBackupRoot(SERVICE_ENVIRONMENT)).toBe(roots.backupRoot);
    expect(protectedRoots({})[0]).toBe("/home/jm/.local/state/orca-jarvis");
  });

  it("points the Second Brain launcher and config at the configured provider roots", () => {
    // Given / When / Then
    expect(secondBrainLauncher(SERVICE_ENVIRONMENT, {}))
      .toBe("/var/lib/jarvis-svc/state/second-brain/app/current/bin/second-brain-mcp");
    expect(secondBrainConfig(SERVICE_ENVIRONMENT, {})).toBe("/var/lib/jarvis-svc/config/second-brain/config.toml");
    expect(secondBrainLauncher({}, {})).toBe("/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp");
    expect(secondBrainConfig({}, {})).toBe("/home/jm/.config/second-brain/config.toml");
  });

  it("uses the bridge launcher when JARVIS_SECOND_BRAIN_LAUNCHER is set", () => {
    const env = {
      JARVIS_SECOND_BRAIN_LAUNCHER: "/opt/jarvis-runtime/bin/second-brain-mcp",
      JARVIS_SECOND_BRAIN_CONFIG: "/var/lib/jarvis-svc/config/second-brain/config.toml",
    };
    expect(secondBrainLauncher(SERVICE_ENVIRONMENT, env)).toBe("/opt/jarvis-runtime/bin/second-brain-mcp");
    expect(secondBrainConfig(SERVICE_ENVIRONMENT, env)).toBe("/var/lib/jarvis-svc/config/second-brain/config.toml");
    expect(secondBrainLauncher(SERVICE_ENVIRONMENT, { JARVIS_SECOND_BRAIN_LAUNCHER: "" }))
      .toBe("/var/lib/jarvis-svc/state/second-brain/app/current/bin/second-brain-mcp");
  });
});
