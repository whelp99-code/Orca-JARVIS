import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { RunnerTrustProfile } from "./runner-trust.js";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxExecAvailable(): boolean {
  if (!existsSync(SANDBOX_EXEC)) return false;
  const probe = spawnSync(SANDBOX_EXEC, ["-p", "(version 1) (allow default)", "/usr/bin/true"], { encoding: "utf8" });
  return probe.status === 0;
}

export function renderSeatbelt(profile: RunnerTrustProfile, authorityDb: string, keyDir: string): string {
  const networks = profile.networkDestinations.map(dest => `    (remote ip \\"${dest}\\")`).join("\n");
  return [
    "(version 1)",
    "(deny default)",
    "(allow file-read* file-write* (subpath \"", profile.workspaceRoot, "\"))",
    "(deny file-read* file-write*",
    `  (literal "${authorityDb}")`,
    `  (subpath "${keyDir}")`,
    "  (regex #\"^.*\\\\.signing-key\\\\.pem$\")",
    "  (regex #\"^.*\\\\.policy-key\\\\.pem$\")",
    "  (subpath \"/Library/Keychains\")",
    "  (subpath \"/Users/.*/Library/Application Support/Google/Chrome\")",
    ")",
    "(deny process-exec (literal \"/bin/launchctl\") (literal \"/usr/bin/launchctl\"))",
    "(deny signal)",
    profile.tier >= 2 && profile.networkDestinations.length > 0
      ? `(allow network-outbound\n${networks}\n)`
      : "(deny network-outbound)",
    "",
  ].join("\n");
}

export function deniedProbeTargets(authorityDb: string, keyPath: string): readonly string[] {
  return [authorityDb, keyPath, "/bin/launchctl", "SSH_AUTH_SOCK", "browser-profile"];
}
