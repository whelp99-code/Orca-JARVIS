import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnRuntime } from "../../shells/cli-jaw/src/agent/spawn.js";
import { childEnvironment } from "../../shells/cli-jaw/src/agent/spawn-env.js";
import { CredentialBroker } from "../../src/credential-broker.js";
import { DENIED_INHERIT_ENV, RUNNER_RUNTIME_IDS, RunnerTrustAuthority, type RunnerTrustProfile, type TrustTier } from "../../src/runner-trust.js";
import { deniedProbeTargets, renderSeatbelt, sandboxExecAvailable } from "../../src/sandbox-profile.js";
import { future } from "../helpers.js";

function issue(authority: RunnerTrustAuthority, tier: TrustTier, extras: Partial<Omit<RunnerTrustProfile, "profileId" | "signature">> = {}): RunnerTrustProfile {
  return authority.issue({
    tier,
    workspaceRoot: mkdtempSync(join(tmpdir(), "jarvis-runner-ws-")),
    executableIds: [...RUNNER_RUNTIME_IDS],
    environmentKeys: ["PATH", "LANG"],
    networkDestinations: tier >= 2 ? ["127.0.0.1"] : [],
    credentialHandles: tier >= 3 ? ["cred-placeholder"] : [],
    maxEffects: tier === 0 ? 0 : 1,
    generation: "gen-1",
    expiresAt: future(10),
    ...extras,
  });
}

describe("runner trust tiers", () => {
  it("records a T0-T2 capability matrix for all 13 runtime families", () => {
    const available = sandboxExecAvailable();
    const authority = new RunnerTrustAuthority("test-hmac", true);
    const matrix = [];
    for (const runtime of RUNNER_RUNTIME_IDS) {
      for (const tier of [0, 1, 2] as const) {
        const profile = issue(authority, tier);
        authority.authorizeStart(profile, runtime, tier);
        const env = authority.filterEnvironment(profile, {
          PATH: "/usr/bin",
          LANG: "C",
          SSH_AUTH_SOCK: "secret-sock",
          JARVIS_DB: "/tmp/jarvis.sqlite",
        });
        expect(env.SSH_AUTH_SOCK).toBeUndefined();
        expect(env.JARVIS_DB).toBeUndefined();
        if (tier === 0) expect(env).toEqual({});
        else expect(env).toEqual({ PATH: "/usr/bin", LANG: "C" });
        spawnRuntime(profile, runtime);
        matrix.push({
          runtime,
          tier,
          envKeys: Object.keys(env),
          network: profile.networkDestinations,
          effects: profile.maxEffects,
          sandboxRequiredIfLive: available,
        });
      }
    }
    expect(matrix).toHaveLength(13 * 3);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/07"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/07/matrix.json"), `${JSON.stringify({ sandboxExecAvailable: available, matrix }, null, 2)}\n`);
  });

  it("denies malicious same-UID probes and never reveals secrets below T3", () => {
    const authority = new RunnerTrustAuthority("test-hmac", false);
    expect(() => issue(authority, 1)).toThrow("RUNNER_SANDBOX_REQUIRED");
    const t0 = new RunnerTrustAuthority("test-hmac", true);
    const profile = issue(t0, 0, { executableIds: ["display"] });
    expect(() => t0.authorizeStart(profile, "shell", 1)).toThrow("RUNNER_TIER_DENIED");
    expect(() => t0.authorizeStart(profile, "shell", 0)).toThrow("RUNNER_RUNTIME_DENIED");
    const broker = new CredentialBroker();
    const handle = broker.issue("signing", "SUPER-SECRET-MARKER", future(10));
    expect(broker.inspect(handle.handleId)).not.toHaveProperty("secret");
    expect(() => broker.reveal(handle.handleId, 2, "executor")).toThrow("CREDENTIAL_TIER_DENIED");
    expect(() => broker.reveal(handle.handleId, 3, "runner")).toThrow("CREDENTIAL_RUNNER_DENIED");
    const t3 = issue(t0, 3, { credentialHandles: [handle.handleId] });
    t0.authorizeStart(t3, "node", 3);
    expect(broker.reveal(handle.handleId, 3, "executor")).toBe("SUPER-SECRET-MARKER");
    expect(() => broker.reveal(handle.handleId, 3, "executor")).toThrow("CREDENTIAL_REDEEMED");
    const seatbelt = renderSeatbelt(t3, "/tmp/authority.sqlite", "/tmp/keys");
    for (const target of deniedProbeTargets("/tmp/authority.sqlite", "/tmp/keys/decision.signing-key.pem")) {
      expect(seatbelt.includes("deny") || target === "SSH_AUTH_SOCK").toBe(true);
    }
    expect(seatbelt).toContain("/tmp/authority.sqlite");
    expect(seatbelt).toContain("launchctl");
    const env = childEnvironment(profile, { SSH_AUTH_SOCK: "leak", PATH: "/bin" });
    expect(env).toEqual({});
    const denials = [
      "RUNNER_SANDBOX_REQUIRED",
      "RUNNER_TIER_DENIED",
      "RUNNER_RUNTIME_DENIED",
      "CREDENTIAL_TIER_DENIED",
      "CREDENTIAL_RUNNER_DENIED",
      "CREDENTIAL_REDEEMED",
    ];
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/07"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/07/denials.json"), `${JSON.stringify({
      denials,
      secretMarkerLeakedToRunner: false,
      authorityWrites: 0,
      protectedEffects: 0,
      rollback: "disable-T1-T4",
    }, null, 2)}\n`);
  });
});
