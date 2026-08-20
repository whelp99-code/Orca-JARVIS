import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UNIT = "deploy/jm-jarvis-dashboard.service";

describe("jm-cloud dashboard systemd unit", () => {
  it("pins loopback node 24 CLI against the JM sqlite", () => {
    expect(existsSync(UNIT), `missing ${UNIT}`).toBe(true);
    const text = readFileSync(UNIT, "utf8");
    expect(text).toContain("127.0.0.1");
    expect(text).toContain("--port 4173");
    expect(text).toContain("/home/jm/.nvm/versions/node/v24.19.0/bin/node");
    expect(text).toContain("dist/src/dashboard/main.js");
    expect(text).toContain("/home/jm/.local/state/orca-jarvis/jarvis.sqlite");
    expect(text).toContain("IPAddressAllow=localhost");
    expect(text).not.toContain("0.0.0.0");
    expect(text).not.toMatch(/--host[=\s]+0\.0\.0\.0/);
  });
});
