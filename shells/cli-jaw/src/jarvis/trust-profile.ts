export type ShellTrustTier = 0 | 1 | 2 | 3 | 4;

export type ShellTrustProfile = {
  readonly profileId: string;
  readonly tier: ShellTrustTier;
  readonly workspaceRoot: string;
  readonly executableIds: readonly string[];
  readonly environmentKeys: readonly string[];
  readonly generation: string;
  readonly expiresAt: string;
};

export function assertSpawnAllowed(profile: ShellTrustProfile | undefined, runtimeId: string): void {
  if (!profile) throw new Error("RUNNER_PROFILE_REQUIRED");
  if (!profile.executableIds.includes(runtimeId)) throw new Error("RUNNER_RUNTIME_DENIED");
  if (Date.parse(profile.expiresAt) <= Date.now()) throw new Error("RUNNER_PROFILE_EXPIRED");
}

export function spawnEnv(profile: ShellTrustProfile, env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set(profile.environmentKeys);
  const next: Record<string, string> = {};
  if (profile.tier === 0) return next;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && allowed.has(key) && key !== "SSH_AUTH_SOCK" && key !== "JARVIS_DB") next[key] = value;
  }
  return next;
}
