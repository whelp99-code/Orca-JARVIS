import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = "ops/authority/publish-verified-release.sh";

describe("verified Authority release entrypoint", () => {
  it("requires approval, seals the artifact, and atomically changes only the current symlink", () => {
    const source = readFileSync(ENTRYPOINT, "utf8");
    execFileSync("bash", ["-n", ENTRYPOINT]);
    const cleanup = /cleanup\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
    expect(cleanup).toBeDefined();
    execFileSync("bash", ["-c", `set -euo pipefail\nstage=""\n${cleanup ?? ""}\ncleanup\n`]);
    expect(source).toContain("JARVIS_PRODUCTION_ACTIVATION_APPROVAL");
    expect(source).toContain("JARVIS_AUTHORITY_RUNTIME_ROOT");
    expect(source).toContain("JARVIS_CONTROL_CENTER_RUNTIME_ROOT");
    expect(source).toContain("writeReleaseManifest");
    expect(source).toContain("release.manifest.json");
    expect(source).toContain("reproducibility_receipt");
    expect(source).toContain("mv -Tf");
    expect(source).toContain("CONTROL_VERIFIER");
    expect(source).not.toContain("git reset");
    expect(source).not.toContain("git clean");
  });
});