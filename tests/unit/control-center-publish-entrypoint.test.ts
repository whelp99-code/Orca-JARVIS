import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = "ops/control-center/publish-verified-release.sh";

describe("verified Control Center release entrypoint", () => {
  it("requires explicit activation approval and uses the installed fail-closed verifier", () => {
    const source = readFileSync(ENTRYPOINT, "utf8");
    execFileSync("bash", ["-n", ENTRYPOINT]);
    expect(source).toContain("JARVIS_PRODUCTION_ACTIVATION_APPROVAL");
    expect(source).toContain("JARVIS_CONTROL_CENTER_RUNTIME_ROOT");
    expect(source).toContain("release-verifier.mjs");
    expect(source).toContain("--write-source-manifest");
    expect(source).toContain("--write-artifact-manifest");
    expect(source).toContain("--normalize-native-build");
    expect(source).toContain("--publish-artifact");
    expect(source).toContain("--activate-release");
    expect(source).toContain("--verify-release");
    expect(source).not.toContain("tailscale funnel");
  });
});