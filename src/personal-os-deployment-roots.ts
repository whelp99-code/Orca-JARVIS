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

/**
 * The configured daily-loop inputs. They have no default: `service run` refuses one flag without
 * the other (DAILY_LOOP_CONFIG_INVALID), so naming a path a deployment has not provisioned would
 * turn Restart=always into a crash loop. Unset means the unit runs without the daily loop - and
 * says so, because the flags are simply absent from the rendered ExecStart. Once named, the inputs
 * are load-bearing and the service fails closed on them rather than skipping the loop in silence.
 */
export const DAILY_SERVICE_VARIABLES = {
  dailyServiceConfig: "JARVIS_DAILY_SERVICE_CONFIG",
  dailyServiceKey: "JARVIS_DAILY_CLOSEOUT_KEY",
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
  taskClaudePath: "JARVIS_TASK_CLAUDE_PATH",
  portfolioSpoolRoot: "JARVIS_PORTFOLIO_SPOOL_ROOT",
} as const;

/**
 * The task executor is a deployment path like any other, and it was the one path the cutover could
 * not carry: the installed executor is pinned inside the interactive user's 0750 home, which a
 * `nologin` service account cannot traverse. A configured deployment therefore defaults it to
 * `<JARVIS_BIN_ROOT>/claude` — the same world-readable bin root the unit's PATH already names — so
 * the operator's job is to put the binary there rather than to widen an ACL over `~/.local/share`.
 * An unconfigured per-user installation keeps no default at all: its executor is whatever the
 * existing drop-in says, and inventing a path there would change a running installation.
 */
export const TASK_EXECUTOR_BIN_NAME = "claude" as const;

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
  readonly taskClaudePath: string | undefined;
  /**
   * The portfolio spool: the one directory two accounts share. The collector writes into it as the
   * interactive user whose GUI session it reads, and the ingest consumes it as the account that
   * owns the authority database, so a deployment that splits those accounts has to name a place
   * both can reach and cannot leave it inside either one's private state.
   */
  readonly portfolioSpoolRoot: string;
  readonly orcaCliRoot: string;
  readonly jarvisDb: string;
  readonly backupRoot: string;
  readonly authorityCurrent: string;
  readonly controlCenterCurrent: string;
  readonly providerCurrent: string;
  readonly providerLauncher: string;
  readonly providerCli: string;
  readonly providerMarker: string;
  readonly dailyServiceConfig: string | undefined;
  readonly dailyServiceKey: string | undefined;
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

/** A path the deployment may name and usually does not. Validated exactly like a configured root. */
function optionalPath(name: string, environment: DeploymentEnvironment): string | undefined {
  if (environment[name] === undefined) return undefined;
  return configuredPath(name, "", environment);
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
  const binRoot = configuredPath(DEPLOYMENT_ROOT_VARIABLES.binRoot,
    DEFAULT_DEPLOYMENT_ROOTS.binRoot, environment);
  const serviceUser = configuredServiceUser(environment);
  const authorityShareRoot = configuredPath(DEPLOYMENT_ROOT_VARIABLES.authorityShareRoot,
    DEFAULT_DEPLOYMENT_ROOTS.authorityShareRoot, environment);
  // The executor registry already treats an empty JARVIS_TASK_CLAUDE_PATH as "not configured"
  // (probeClaudeTaskAuthentication, createClaudeRuntime), so the roots read it the same way rather
  // than refusing an environment the rest of the product accepts.
  const configuredExecutor = environment[DEPLOYMENT_ROOT_VARIABLES.taskClaudePath]
    ? configuredPath(DEPLOYMENT_ROOT_VARIABLES.taskClaudePath, "", environment)
    : undefined;
  const dailyServiceConfig = optionalPath(DAILY_SERVICE_VARIABLES.dailyServiceConfig, environment);
  const dailyServiceKey = optionalPath(DAILY_SERVICE_VARIABLES.dailyServiceKey, environment);
  // `service run` takes both inputs or neither, so half a configuration is refused where the
  // operator can still read the error, not by a unit that restarts forever.
  if ((dailyServiceConfig === undefined) !== (dailyServiceKey === undefined)) {
    throw new PersonalOsError("E_DEPLOYMENT_ROOT");
  }
  return {
    dailyServiceConfig,
    dailyServiceKey,
    stateRoot,
    providerStateRoot,
    providerConfig,
    providerShareRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.providerShareRoot,
      DEFAULT_DEPLOYMENT_ROOTS.providerShareRoot, environment),
    authorityShareRoot,
    portfolioSpoolRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.portfolioSpoolRoot,
      `${authorityShareRoot}/portfolio-spool`, environment),
    orcaCliRoot: `${stateRoot}/orca-cli`,
    configRoot: configuredPath(DEPLOYMENT_ROOT_VARIABLES.configRoot,
      DEFAULT_DEPLOYMENT_ROOTS.configRoot, environment),
    binRoot,
    nodeBin: configuredPath(DEPLOYMENT_ROOT_VARIABLES.nodeBin,
      DEFAULT_DEPLOYMENT_ROOTS.nodeBin, environment),
    serviceUser,
    taskClaudePath: configuredExecutor
      ?? (serviceUser === undefined ? undefined : `${binRoot}/${TASK_EXECUTOR_BIN_NAME}`),
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
