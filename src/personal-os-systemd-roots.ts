import {
  type DeploymentEnvironment,
  resolveDeploymentRoots,
} from "./personal-os-deployment-roots.js";

export type RenderMode = "production" | "fixture";

/**
 * Every path a generated unit names. There is no default: the caller passes the roots it means,
 * which is what lets the same renderer emit the per-user installation under /home/jm and the
 * system installation that runs as a dedicated service account.
 */
export type RenderRoots = {
  readonly authorityCurrent: string;
  readonly controlCenterCurrent: string;
  readonly jarvisDb: string;
  readonly backupRoot: string;
  readonly providerCurrent: string;
  readonly providerState: string;
  readonly providerShare: string;
  readonly providerConfig: string;
  readonly providerMarker: string;
  readonly nodeBin: string;
  readonly binRoot: string;
  /** When set the unit is a system unit that runs as this account; unset renders a user unit. */
  readonly serviceUser?: string | undefined;
};

/** The roots of the configured deployment — the /home/jm installation when nothing is set. */
export function productionRoots(environment?: DeploymentEnvironment): RenderRoots {
  const roots = resolveDeploymentRoots(environment);
  return {
    authorityCurrent: roots.authorityCurrent,
    controlCenterCurrent: roots.controlCenterCurrent,
    jarvisDb: roots.jarvisDb,
    backupRoot: roots.backupRoot,
    providerCurrent: roots.providerCurrent,
    providerState: roots.providerStateRoot,
    providerShare: roots.providerShareRoot,
    providerConfig: roots.providerConfig,
    providerMarker: roots.providerMarker,
    nodeBin: roots.nodeBin,
    binRoot: roots.binRoot,
    serviceUser: roots.serviceUser,
  };
}

/**
 * Roots entirely inside one isolated directory. Fixtures, rehearsals and the stress harness build
 * their units from this, so a field added to RenderRoots can never quietly default to a production
 * path in a test.
 */
export function isolatedRenderRoots(input: {
  readonly root: string;
  readonly authorityCurrent?: string;
  readonly controlCenterCurrent?: string;
  readonly jarvisDb?: string;
  readonly providerCurrent?: string;
}): RenderRoots {
  const root = input.root;
  return {
    authorityCurrent: input.authorityCurrent ?? `${root}/authority/current`,
    controlCenterCurrent: input.controlCenterCurrent ?? `${root}/control-center/current`,
    jarvisDb: input.jarvisDb ?? `${root}/jarvis.sqlite`,
    backupRoot: `${root}/backups`,
    providerCurrent: input.providerCurrent ?? `${root}/provider/current`,
    providerState: `${root}/provider`,
    providerShare: `${root}/provider-share`,
    providerConfig: `${root}/provider/config.toml`,
    providerMarker: `${root}/provider/request-executor.enabled`,
    nodeBin: process.execPath,
    binRoot: `${root}/bin`,
  };
}
