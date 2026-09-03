import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePhoneServeSpec } from "../../src/phone-gateway.js";

const UNIT = "deploy/jm-jarvis-phone-gateway.service";
const SERVE = "deploy/jm-jarvis-phone-gateway-serve.json";

describe("phone gateway systemd and serve artifacts", () => {
  it("pins a loopback Node 24 gateway behind the dashboard unit", () => {
    expect(existsSync(UNIT), `missing ${UNIT}`).toBe(true);
    const text = readFileSync(UNIT, "utf8");
    expect(text).toContain("Description=JM JARVIS phone gateway (tailnet Serve backend, loopback 4176)");
    expect(text).toContain("After=jm-jarvis-dashboard.service");
    expect(text).toContain("Requires=jm-jarvis-dashboard.service");
    expect(text).toContain("/home/jm/.nvm/versions/node/v24.19.0/bin/node");
    expect(text).toContain("dist/src/phone-gateway-main.js");
    expect(text).toContain("--host 127.0.0.1");
    expect(text).toContain("--port 4176");
    expect(text).toContain("--upstream http://127.0.0.1:4173");
    expect(text).toContain("EnvironmentFile=%h/.config/orca-jarvis/phone-gateway.env");
    expect(text).toContain("--env-file %h/.config/orca-jarvis/phone-gateway.env");
    expect(text).toContain("NODE_ENV=production");
    expect(text).toContain("UMask=0077");
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("RestartSec=5");
    expect(text).toContain("StartLimitIntervalSec=60");
    expect(text).toContain("StartLimitBurst=5");
    expect(text).toContain("NoNewPrivileges=true");
    expect(text).toContain("PrivateTmp=true");
    expect(text).toContain("ProtectSystem=strict");
    expect(text).toContain("ProtectHome=read-only");
    expect(text).toContain("RestrictSUIDSGID=true");
    expect(text).toContain("LockPersonality=true");
    expect(text).toContain("RestrictAddressFamilies=AF_INET");
    expect(text).toContain("IPAddressDeny=any");
    expect(text).toContain("IPAddressAllow=localhost");
    expect(text).toContain("SystemCallArchitectures=native");
    expect(text).toContain("SystemCallFilter=@system-service");
    expect(text).toContain("WantedBy=default.target");
    expect(text).not.toContain("ReadWritePaths=");
    expect(text).not.toContain("0.0.0.0");
    expect(text).not.toMatch(/tailscale/i);
    expect(text).not.toMatch(/funnel/i);
    expect(text).not.toMatch(/\.plist/);
  });

  it("pins the env file schema to JARVIS_PHONE runtime keys", () => {
    const schema = JSON.parse(readFileSync("config/phone-gateway.env.schema.json", "utf8")) as {
      readonly required: readonly string[];
    };
    expect(schema.required).toEqual([
      "JARVIS_PHONE_PUBLIC_ORIGIN",
      "JARVIS_PHONE_OWNER_LOGIN",
      "JARVIS_PHONE_SESSION_KEY_FILE",
    ]);
  });

  it("parses the frozen tailnet-only Serve spec and never invokes Tailscale", () => {
    const parsed = parsePhoneServeSpec(readFileSync(SERVE, "utf8"));
    expect(parsed).toEqual({
      schema_version: 1,
      exposure: "tailnet-only",
      protocol: "https",
      port: 8444,
      target: "http://127.0.0.1:4176",
      funnel: false,
      command_argv: ["tailscale", "serve", "--bg", "--https=8444", "http://127.0.0.1:4176"],
    });
    expect(parsed.funnel).toBe(false);
    expect(parsed.command_argv.join(" ").toLowerCase()).not.toContain("funnel");
  });
});
