import {
  type DeploymentEnvironment,
  resolveDeploymentRoots,
} from "./personal-os-deployment-roots.js";

/**
 * The deployed provider endpoint. Both follow the configured provider roots
 * (JARVIS_PROVIDER_STATE_ROOT / JARVIS_PROVIDER_CONFIG), so an authority moved to a service
 * account talks to that account's provider installation instead of the interactive user's.
 * JARVIS_SECOND_BRAIN_LAUNCHER/CONFIG still override both, and still select an isolated provider.
 */
export function secondBrainLauncher(environment?: DeploymentEnvironment): string {
  return resolveDeploymentRoots(environment).providerLauncher;
}

export function secondBrainConfig(environment?: DeploymentEnvironment): string {
  return resolveDeploymentRoots(environment).providerConfig;
}
