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
function configuredOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function secondBrainLauncher(environment?: DeploymentEnvironment, env: NodeJS.ProcessEnv = process.env): string {
  return configuredOverride(env, "JARVIS_SECOND_BRAIN_LAUNCHER")
    ?? resolveDeploymentRoots(environment).providerLauncher;
}

export function secondBrainConfig(environment?: DeploymentEnvironment, env: NodeJS.ProcessEnv = process.env): string {
  return configuredOverride(env, "JARVIS_SECOND_BRAIN_CONFIG")
    ?? resolveDeploymentRoots(environment).providerConfig;
}
