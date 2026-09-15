import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryExecuteDeploymentCommand } from "../../src/cli-deployment-commands.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const name of ["JARVIS_STATE_ROOT", "JARVIS_PROVIDER_STATE_ROOT", "JARVIS_PROVIDER_CONFIG",
    "JARVIS_PROVIDER_SHARE_ROOT", "JARVIS_SHARE_ROOT", "JARVIS_CONFIG_ROOT", "JARVIS_BIN_ROOT",
    "JARVIS_NODE_BIN", "JARVIS_SERVICE_USER"]) {
    delete process.env[name];
  }
});

function serviceEnvironment(): void {
  process.env["JARVIS_STATE_ROOT"] = "/var/lib/jarvis-svc/state/orca-jarvis";
  process.env["JARVIS_PROVIDER_STATE_ROOT"] = "/var/lib/jarvis-svc/state/second-brain";
  process.env["JARVIS_PROVIDER_CONFIG"] = "/var/lib/jarvis-svc/config/second-brain/config.toml";
  process.env["JARVIS_PROVIDER_SHARE_ROOT"] = "/var/lib/jarvis-svc/share/second-brain";
  process.env["JARVIS_SHARE_ROOT"] = "/var/lib/jarvis-svc/share/jarvis";
  process.env["JARVIS_CONFIG_ROOT"] = "/var/lib/jarvis-svc/config";
  process.env["JARVIS_BIN_ROOT"] = "/opt/jarvis-runtime/bin";
  process.env["JARVIS_NODE_BIN"] = "/opt/jarvis-runtime/bin/node";
  process.env["JARVIS_SERVICE_USER"] = "jarvis-svc";
}

describe("deployment CLI", () => {
  it("reports the unconfigured deployment and names its remaining home paths", () => {
    // Given / When
    const result = tryExecuteDeploymentCommand({ positionals: ["deployment", "roots"], values: {} });

    // Then
    expect(result).toMatchObject({ ok: true, command: "deployment.roots" });
    expect(Reflect.get(result ?? {}, "roots")).toMatchObject({
      jarvisDb: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
      serviceUser: undefined,
    });
    // Every root is still under the interactive user's home before the cutover, and the command
    // says so rather than leaving the operator to compare paths by eye.
    expect(Reflect.get(result ?? {}, "home_paths")).toContain("jarvisDb");
  });

  it("reports an empty home-path set once the service-user roots are configured", () => {
    // Given
    serviceEnvironment();

    // When
    const result = tryExecuteDeploymentCommand({ positionals: ["deployment", "roots"], values: {} });

    // Then
    expect(Reflect.get(result ?? {}, "home_paths")).toEqual([]);
    expect(Reflect.get(result ?? {}, "roots")).toMatchObject({ serviceUser: "jarvis-svc" });
  });

  it("renders every generated unit into an output directory, naming no home path", () => {
    // Given
    serviceEnvironment();
    const out = mkdtempSync(join(tmpdir(), "jarvis-units-"));
    scratch.push(out);

    // When
    const result = tryExecuteDeploymentCommand({
      positionals: ["deployment", "render-units"], values: { out },
    });

    // Then
    const units = Reflect.get(result ?? {}, "units") as ReadonlyArray<Record<string, unknown>>;
    expect(units).toHaveLength(8);
    expect(units.filter(unit => unit["names_home"] === true)).toEqual([]);
    expect(Reflect.get(result ?? {}, "service_user")).toBe("jarvis-svc");
    for (const unit of units) {
      const path = String(unit["path"]);
      expect(statSync(path).isFile()).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain("/home/");
    }
    expect(readFileSync(join(out, "jm-jarvis.service"), "utf8")).toContain("User=jarvis-svc");
  });

  it("refuses a render without an absolute output directory and a roots call with one", () => {
    // Given / When / Then
    expect(() => tryExecuteDeploymentCommand({
      positionals: ["deployment", "render-units"], values: { out: "units" },
    })).toThrow("CLI_ARGUMENT_INVALID");
    expect(() => tryExecuteDeploymentCommand({
      positionals: ["deployment", "render-units"], values: {},
    })).toThrow("CLI_ARGUMENT_INVALID");
    expect(() => tryExecuteDeploymentCommand({
      positionals: ["deployment", "roots"], values: { out: "/tmp/x" },
    })).toThrow("CLI_ARGUMENT_INVALID");
    expect(tryExecuteDeploymentCommand({ positionals: ["doctor"], values: {} })).toBeUndefined();
    expect(tryExecuteDeploymentCommand({ positionals: ["deployment", "nope"], values: {} })).toBeUndefined();
  });
});
