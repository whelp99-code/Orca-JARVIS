import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DROP_IN = "deploy/jm-jarvis.service.d/10-orca-integration.conf";

describe("JARVIS ORCA systemd integration", () => {
  it("preserves local ORCA observation without replacing the authority command", () => {
    const text = readFileSync(DROP_IN, "utf8");
    expect(text).toContain("After=orca-gui.service tailscaled.service");
    expect(text).toContain("Wants=orca-gui.service");
    expect(text).toContain("Environment=ORCA_JARVIS_ENVIRONMENTS=local");
    expect(text).toContain("SyslogIdentifier=jm-jarvis");
    expect(text).not.toContain("ExecStart=");
    expect(text).not.toContain("ORCA_CLI_COMMAND=");
  });
});