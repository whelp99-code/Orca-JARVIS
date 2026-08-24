import { spawnEnv, type ShellTrustProfile } from "../jarvis/trust-profile.js";

export function childEnvironment(profile: ShellTrustProfile, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return spawnEnv(profile, env);
}
