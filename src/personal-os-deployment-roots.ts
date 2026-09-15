import { dirname, isAbsolute, resolve } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";

/**
 * Every filesystem root this deployment owns is resolved here, once, from the environment.
 *
 * The defaults are the /home/jm deployment that exists today, so an unset environment keeps the
 * running installation byte-identical. They are defaults and not constants because the retention
 * and compaction lanes can only prove exclusion when the authority runs under an account that owns
 * nothing else (docs/local-retention-operations-proposal.md), and moving the authority to such an
 * account moves every one of these paths at once. A path hard-coded anywhere else would be a path
 * that silently stayed behind in the interactive user's home.
 */
export const DEFAULT_DEPLOYMENT_ROOTS = {
  stateRoot: "/home/jm/.local/state/orca-jarvis",
  providerStateRoot: "/home/jm/.local/state/second-brain",
  providerConfig: "/home/jm/.config/second-brain/config.toml",
  providerShareRoot: "/home/jm/.local/share/second-brain",
  authorityShareRoot: "/home/jm/.local/share/jarvis",
  configRoot: "/home/jm/.config",
  binRoot: "/home/jm/.local/bin",
  nodeBin: "/home/jm/.nvm/versions/node/v24.19.0/bin/node",
} as const;

export const DEPLOYMENT_ROOT_VARIABLES = {
  stateRoot: "JARVIS_STATE_ROOT",
  providerStateRoot: "JARVIS_PROVIDER_STATE_ROOT",
  providerConfig: "JARVIS_PROVIDER_CONFIG",
  providerShareRoot: "JARVIS_PROVIDER_SHARE_ROOT",
  authorityShareRoot: "JARVIS_SHARE_ROOT",
  configRoot: "JARVIS_CONFIG_ROOT",
  binRoot: "JARVIS_BIN_ROOT",
  nodeBin: "JARVIS_NODE_BIN",
} as const;

/** The account the generated system units run as; unset means the current per-user installation. */
export const SERVICE_USER_VARIABLE = "JARVIS_SERVICE_USER" as const;

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export type DeploymentRoots = {
  readonly stateRoot: string;
  readonly providerStateRoot: string;
  readonly providerConfig: string;
  readonly providerShareRoot: string;
  readonly authorityShareRoot: string;
  readonly configRoot: string;
  readonly binRoot: string;
  readonly nodeBin: string;
  readonly serviceUser: string | undefined;
  readonly jarvisDb: string;
  readonly backupRoot: string;
  readonly authorityCurrent: string;
  readonly controlCenterCurrent: string;
  readonly providerCurrent: string;
  readonly providerLauncher: string;
  readonly providerCli: string;
  readonly providerMarker: string;
};

function configuredPath(name: string, fallback: string, environment: DeploymentEnvironment): string {
  const value = environment[name];
  if (value === undefined) return fallback;
  // A relative override would resolve against whatever directory the service happened to start in,
  // and a non-canonical one would compare unequal to the same path written plainly — and these
  // paths are compared, not just opened (assertIsolatedRoot, assertProductionBackupPaths). Both are
  // refused at the boundary rather than normalised into something the operator did not write.
  if (value === "" || !isAbsolute(value) || resolve(value) !== value) {
    throw new PersonalOsError("E_DEPLOYMENT_ROOT");
  }
  return value;
}

function configuredServiceUser(environment: DeploymentEnvironment): string | undefined {
  const value = environment[SERVICE_USER_VARIABLE];
  if (value === undefined) return undefined;
  // The value is written verbatim into a unit's `User=`, so only a POSIX account name is accepted.
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new PersonalOsError("E_DEPLOYMENT_ROOT");
  return value;
}

export function resolveDeploymentRoots(
  environment: DeploymentEnvironment = process.env,
): DeploymentRoots {
  const stateRoot = configuredPath(DEPLOYMENT_ROOT_VARIABLES.stateRoot,
    DEFAULT_DEPLOYMENT_ROOTS.stateRoot, environment);
  const providerStateRoot = configuredPath(DEPLOYMENT_ROOT_VARIABLES.providerStateRoot,
    DEFAULT_DEPLOYMENT_ROOTS.providerStateRoot, environment);
  const providerConfig = configuredPath(DEPLOYMENT_ROOT_VARIABLES.providerConfig,
    DEFAULT_DEPLOYMENT_ROOTS.providerConfig, environment);
  const providerCurrent = `${providerStateRoot}/app/current`;
  return {
    stateRoot,
    providerStateRoot,
    providerConfig,
    providerShareRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.providerShareRoot,
      DEFAULT_DEPLOYMENT_ROOTS.providerShareRoot, environment),
    authorityShareRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.authorityShareRoot,
      DEFAULT_DEPLOYMENT_ROOTS.authorityShareRoot, environment),
    configRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.configRoot,
      DEFAULT_DEPLOYMENT_ROOTS.configRoot, environment),
    binRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.binRoot,
      DEFAULT_DEPLOYMENT_ROOTS.binRoot, environment),
    nodeBin: configuredPath(DEPLOYMENT_ROOT_VARIABLES.nodeBin,
      DEFAULT_DEPLOYMENT_ROOTS.nodeBin, environment),
    serviceUser: configuredServiceUser(environment),
    jarvisDb: `${stateRoot}/jarvis.sqlite`,
    backupRoot: `${stateRoot}/backups`,
    authorityCurrent: `${stateRoot}/authority/current`,
    controlCenterCurrent: `${stateRoot}/control-center/current`,
    providerCurrent,
    providerLauncher: `${providerCurrent}/bin/second-brain-mcp`,
    providerCli: `${providerCurrent}/bin/sb`,
    // The request-executor marker is provisioned beside the config it belongs to
    // (ops/second-brain/provision-request-executor-keys.mjs), so it moves with it.
    providerMarker: `${dirname(providerConfig)}/request-executor.enabled`,
  };
}
