import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DEPLOY = join(process.cwd(), "deploy");
const ARCHIVE = join(process.cwd(), "docs/historical/mac-launchagents");
const DASHBOARD = "com.jmpark.orca-jarvis-dashboard.plist";
const TUNNEL = "com.jmpark.orca-jarvis-dashboard-tunnel.plist";
const LINUX_DASHBOARD = "jm-jarvis-dashboard.service";

describe("Mac dashboard LaunchAgent archive", () => {
  it("does not keep a Mac AuthorityDb runtime path in deploy/", () => {
    // Given
    const deployNames = readdirSync(DEPLOY);

    // When
    const dashboardInDeploy = deployNames.includes(DASHBOARD);
    const tunnelInDeploy = deployNames.includes(TUNNEL);

    // Then
    expect(dashboardInDeploy).toBe(false);
    expect(tunnelInDeploy).toBe(false);
    expect(existsSync(join(DEPLOY, DASHBOARD))).toBe(false);
    expect(existsSync(join(DEPLOY, TUNNEL))).toBe(false);
    expect(deployNames).toContain(LINUX_DASHBOARD);
  });

  it("archives the plists as HISTORICAL_NON_EXECUTABLE and points at Linux authority", () => {
    // Given
    const dashboard = readFileSync(join(ARCHIVE, DASHBOARD), "utf8");
    const tunnel = readFileSync(join(ARCHIVE, TUNNEL), "utf8");
    const readme = readFileSync(join(ARCHIVE, "README.md"), "utf8");

    // When
    const dashboardLoadsAtBoot = /<key>RunAtLoad<\/key>\s*<true\/>/.test(dashboard);
    const tunnelLoadsAtBoot = /<key>RunAtLoad<\/key>\s*<true\/>/.test(tunnel);

    // Then
    expect(dashboard).toContain("HISTORICAL_NON_EXECUTABLE");
    expect(tunnel).toContain("HISTORICAL_NON_EXECUTABLE");
    expect(readme).toContain("HISTORICAL_NON_EXECUTABLE");
    expect(readme).toContain("docs/personal-os/release.md");
    expect(readme).toContain("deploy/jm-jarvis-dashboard.service");
    expect(dashboardLoadsAtBoot).toBe(false);
    expect(tunnelLoadsAtBoot).toBe(false);
  });
});
