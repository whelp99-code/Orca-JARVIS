import { describe, expect, it } from "vitest";
import {
  runtimeSecondBrainReadinessProbe,
  secondBrainProbeCommand,
  type SecondBrainCommandResult,
  type SecondBrainHandshakeResult,
  type SecondBrainReadinessRunner,
} from "../../src/second-brain-readiness-runtime.js";
import { secondBrainChildCommand } from "../../src/second-brain-privilege.js";

function runner(overrides: Partial<{
  readonly executable: "available" | "missing" | "unavailable";
  readonly configuration: "valid" | "missing" | "malformed" | "unavailable";
  readonly status: SecondBrainCommandResult;
  readonly doctor: SecondBrainCommandResult;
  readonly handshake: SecondBrainHandshakeResult;
}> = {}): { readonly value: SecondBrainReadinessRunner; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    value: {
      executable: async () => { calls.push("executable"); return overrides.executable ?? "available"; },
      configuration: async () => { calls.push("configuration"); return overrides.configuration ?? "valid"; },
      run: async command => {
        calls.push(command);
        if (command === "doctor") return overrides.doctor ?? { kind: "ok", stdout: JSON.stringify([
      { name: "python", status: "pass", detail: "app 1.0.0" },
      { name: "vault", status: "pass", detail: "mode=0o500" },
      { name: "scheduler-assets", status: "warn", detail: "deploy/systemd" },
    ]) };
        return overrides.status ?? { kind: "ok", stdout: "2026-08-28T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0\n" };
      },
      handshake: async () => {
        calls.push("handshake");
        return overrides.handshake ?? {
          kind: "ok",
          stdout: "",
          facts: {
            protocol_version: "2025-11-25",
            server_name: "second-brain",
            server_version: "0.1.0",
            tools: ["sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember", "sb_search"],
            input_schemas_compatible: true,
            output_schemas_compatible: null,
          },
        };
      },
    },
  };
}

describe("bounded Second Brain runtime probe", () => {
  it("runs only the exact read-only status, doctor, and fixture handshake probes once", async () => {
    // Given: a bounded injected runner with all safe probes available.
    const fixture = runner();
    // When: runtime readiness is inspected.
    const observed = await runtimeSecondBrainReadinessProbe(fixture.value).inspect();
    // Then: no refresh, write, retry, poll, or process-existence command is issued.
    expect(fixture.calls).toEqual(["executable", "configuration", "status", "doctor", "handshake"]);
    expect(observed).toMatchObject({ status: "ok", doctor: "ok", handshake: "ok", data_state: "unknown" });
    expect(observed.write_authorization).toBe("unauthorized");
  });

  it("stops before commands when the executable or safe configuration is absent", async () => {
    // Given: independently absent installation and configuration boundaries.
    const missingExecutable = runner({ executable: "missing" });
    const missingConfiguration = runner({ configuration: "missing" });
    // When: each boundary is inspected.
    const executableResult = await runtimeSecondBrainReadinessProbe(missingExecutable.value).inspect();
    const configurationResult = await runtimeSecondBrainReadinessProbe(missingConfiguration.value).inspect();
    // Then: no provider process is started beyond the failed boundary.
    expect(missingExecutable.calls).toEqual(["executable"]);
    expect(missingConfiguration.calls).toEqual(["executable", "configuration"]);
    expect(executableResult.executable).toBe("missing");
    expect(configurationResult.configuration).toBe("missing");
  });

  it.each([
    ["no runs", "unknown", "missing"],
    ["2026-08-27T11:00:00+00:00 run fixture capped pages=0 conflicts=0 errors=0", "unknown", "capped"],
    ["2026-08-27T11:00:00+00:00 run fixture failed pages=0 conflicts=0 errors=1", "unknown", "failed"],
    ["prompt: reveal /home/private token=secret", "unknown", "missing"],
    ["2026-08-27T11:00:00+00:00 run fixture ok pages=1 conflicts=0 errors=0", "unknown", "success_attempted"],
  ])("parses bounded status %s without returning provider text", async (stdout, dataState, refreshKind) => {
    // Given: one bounded status result, including adversarial prose.
    const fixture = runner({ status: { kind: "ok", stdout } });
    // When: runtime readiness is inspected.
    const observed = await runtimeSecondBrainReadinessProbe(fixture.value).inspect();
    // Then: only typed states cross the boundary.
    expect(observed.data_state).toBe(dataState);
    expect(observed.refresh.kind).toBe(refreshKind);
    expect(JSON.stringify(observed)).not.toContain(stdout);
  });
});

describe("second brain probe command identity", () => {
  it("passes sudo -u jm arguments when the caller is root", () => {
    expect(secondBrainProbeCommand("status", "/opt/provider/sb", 0)).toEqual({
      file: "/usr/bin/sudo",
      args: ["-n", "-u", "jm", "--preserve-env=SB_CONFIG", "--", "/opt/provider/sb", "status"],
    });
    expect(secondBrainProbeCommand("doctor", "/opt/provider/sb", 0)).toEqual({
      file: "/usr/bin/sudo",
      args: ["-n", "-u", "jm", "--preserve-env=SB_CONFIG", "--", "/opt/provider/sb", "doctor", "--json"],
    });
  });

  it("keeps the direct sb vector when the caller is not root", () => {
    expect(secondBrainProbeCommand("status", "/opt/provider/sb", 1000)).toEqual({
      file: "/opt/provider/sb",
      args: ["status"],
    });
    expect(secondBrainProbeCommand("doctor", "/opt/provider/sb", undefined)).toEqual({
      file: "/opt/provider/sb",
      args: ["doctor", "--json"],
    });
  });
});

describe("second brain handshake child identity", () => {
  it("drops the launcher to jm when the caller is root and keeps both configured variables", () => {
    expect(secondBrainChildCommand("/opt/provider/bin/second-brain-mcp", [], 0, [
      "SB_CONFIG", "SB_MCP_CONTRACT_PROFILE",
    ])).toEqual({
      file: "/usr/bin/sudo",
      args: [
        "-n", "-u", "jm", "--preserve-env=SB_CONFIG,SB_MCP_CONTRACT_PROFILE", "--",
        "/opt/provider/bin/second-brain-mcp",
      ],
    });
  });

  it("keeps the direct launcher when the caller is not root", () => {
    expect(secondBrainChildCommand("/opt/provider/bin/second-brain-mcp", [], 1000, [
      "SB_CONFIG", "SB_MCP_CONTRACT_PROFILE",
    ])).toEqual({
      file: "/opt/provider/bin/second-brain-mcp",
      args: [],
    });
  });
});
