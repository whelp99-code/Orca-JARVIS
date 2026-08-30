import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const units = [
  "deploy/jm-jarvis-daily-control.service",
  "deploy/jm-jarvis-daily-control.timer",
  "deploy/jm-jarvis-memory-settlement@.service",
  "deploy/jm-jarvis-phone-gateway.service",
  "deploy/jm-second-brain-refresh.service",
  "deploy/jm-second-brain-refresh.timer",
] as const;

describe("runtime deployment artifacts", () => {
  it("uses the existing immutable release and authority database layout", () => {
    for (const unit of units) {
      const text = read(unit);
      expect(text).not.toContain("/home/jm/.local/state/jarvis/");
      expect(text).not.toContain("/home/jm/.local/share/jarvis/");
      expect(text).not.toMatch(/^User=/mu);
      expect(text).not.toContain("/usr/bin/node");
    }
    const daily = read("deploy/jm-jarvis-daily-control.service");
    expect(daily).toContain("Type=oneshot");
    expect(daily).toContain("/home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(daily).toContain("scripts/jarvis-daily-control.mjs once");
    const settlement = read("deploy/jm-jarvis-memory-settlement@.service");
    expect(settlement).toContain("SECOND_BRAIN_PROVIDER_BIN=/home/jm/.local/bin/sb");
    expect(settlement).toContain("/home/jm/.local/share/second-brain");
    const refresh = read("deploy/jm-second-brain-refresh.service");
    expect(refresh).toContain("ExecStart=/home/jm/.local/bin/sb run");
    expect(refresh).not.toContain("--refresh");
  });

  it("keeps timers persistent and the phone gateway loopback-only", () => {
    const daily = read("deploy/jm-jarvis-daily-control.timer");
    expect(daily).toContain("07:15:00 Asia/Seoul");
    expect(daily).toContain("21:30:00 Asia/Seoul");
    expect(daily).toContain("Persistent=true");
    const refresh = read("deploy/jm-second-brain-refresh.timer");
    expect(refresh).toContain("07:00:00 Asia/Seoul");
    expect(refresh).toContain("Persistent=true");
    const phone = read("deploy/jm-jarvis-phone-gateway.service");
    expect(phone).toContain("EnvironmentFile=/home/jm/.config/orca-jarvis/phone-gateway.env");
    expect(phone).toContain("IPAddressDeny=any");
    expect(phone).toContain("IPAddressAllow=localhost");
  });

  it("ships executable stdio and worker entrypoints without a dead MCP service", () => {
    expect(existsSync(join(root, "deploy/jm-jarvis-agent-mcp.service"))).toBe(false);
    for (const script of [
      "scripts/jarvis-agent-mcp.mjs",
      "scripts/jarvis-daily-control.mjs",
      "scripts/jarvis-memory-settlement.mjs",
      "scripts/collect-terminal-evidence.mjs",
    ]) {
      accessSync(join(root, script), constants.R_OK);
      expect(read(script).startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });
});
