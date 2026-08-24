import { createHmac, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

export const RUNNER_RUNTIME_IDS = [
  "display",
  "node",
  "python",
  "bun",
  "go",
  "rustc",
  "shell",
  "git",
  "browser",
  "playwright",
  "docker",
  "mcp",
  "file",
] as const;
export type RunnerRuntimeId = (typeof RUNNER_RUNTIME_IDS)[number];
export type TrustTier = 0 | 1 | 2 | 3 | 4;

export type RunnerTrustProfile = {
  readonly profileId: string;
  readonly tier: TrustTier;
  readonly workspaceRoot: string;
  readonly executableIds: readonly RunnerRuntimeId[];
  readonly environmentKeys: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly credentialHandles: readonly string[];
  readonly maxEffects: number;
  readonly generation: string;
  readonly expiresAt: string;
  readonly signature: string;
};

export const DENIED_INHERIT_ENV = [
  "SSH_AUTH_SOCK",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "JARVIS_DB",
  "JARVIS_RUNTIME_HOME",
] as const;

const SECRET_ENV = new Set(DENIED_INHERIT_ENV);

export class RunnerTrustAuthority {
  constructor(private readonly hmacKey: string, private readonly sandboxAvailable: boolean) {}

  issue(input: Omit<RunnerTrustProfile, "profileId" | "signature">, now = new Date()): RunnerTrustProfile {
    if (!this.sandboxAvailable && input.tier > 0) throw new JarvisError("RUNNER_SANDBOX_REQUIRED");
    if (Date.parse(input.expiresAt) <= now.getTime()) throw new JarvisError("RUNNER_PROFILE_EXPIRED");
    const profileId = `rtp_${randomUUID()}`;
    const unsigned = { ...input, profileId, signature: "" };
    return { ...unsigned, signature: this.sign(unsigned) };
  }

  verify(profile: RunnerTrustProfile, now = new Date()): void {
    if (this.sign({ ...profile, signature: "" }) !== profile.signature) throw new JarvisError("RUNNER_PROFILE_INVALID");
    if (Date.parse(profile.expiresAt) <= now.getTime()) throw new JarvisError("RUNNER_PROFILE_EXPIRED");
    if (!this.sandboxAvailable && profile.tier > 0) throw new JarvisError("RUNNER_SANDBOX_REQUIRED");
  }

  authorizeStart(profile: RunnerTrustProfile, runtime: RunnerRuntimeId, requestedTier: TrustTier, now = new Date()): void {
    this.verify(profile, now);
    if (requestedTier > profile.tier) throw new JarvisError("RUNNER_TIER_DENIED");
    if (!profile.executableIds.includes(runtime)) throw new JarvisError("RUNNER_RUNTIME_DENIED");
    if (requestedTier >= 3 && profile.credentialHandles.length === 0) throw new JarvisError("RUNNER_CREDENTIAL_REQUIRED");
  }

  filterEnvironment(profile: RunnerTrustProfile, env: NodeJS.ProcessEnv): Record<string, string> {
    const allowed = new Set(profile.environmentKeys);
    const next: Record<string, string> = {};
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (value === undefined) continue;
      if ((SECRET_ENV as ReadonlySet<string>).has(key)) continue;
      if (profile.tier === 0) continue;
      if (!allowed.has(key)) continue;
      next[key] = value;
    }
    return next;
  }

  private sign(profile: Omit<RunnerTrustProfile, "signature"> & { signature: string }): string {
    return createHmac("sha256", this.hmacKey).update(canonicalize({ ...profile, signature: "" })).digest("hex");
  }
}
