import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = "ops/second-brain/jm-second-brain-refresh.sh";

describe("Second Brain production refresh entrypoint", () => {
  it("uses only the immutable current release and the JARVIS provider profile", () => {
    const source = readFileSync(ENTRYPOINT, "utf8");
    execFileSync("bash", ["-n", ENTRYPOINT]);
    expect(source).toContain("/home/jm/.local/state/second-brain");
    expect(source).toContain('readonly CURRENT="${APP_ROOT}/current"');
    expect(source).toContain('readonly RELEASES="${APP_ROOT}/releases"');
    expect(source).toContain("/home/jm/.config/second-brain/jarvis-provider.toml");
    expect(source).toContain('exec "${CLI}" run');
    expect(source).not.toMatch(/\/home\/jm\/orca\/(?:projects|workspaces)\//);
  });
});