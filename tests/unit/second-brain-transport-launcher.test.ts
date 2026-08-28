import { execFile } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  SECOND_BRAIN_CONFIG,
  SECOND_BRAIN_FRAME_BYTES,
  SECOND_BRAIN_LAUNCHER,
  SECOND_BRAIN_PROTOCOL_VERSION,
  createSecondBrainTransport,
  type SecondBrainExecFile,
  type SecondBrainExecFileOptions,
} from "../../src/second-brain-transport.js";
import { ManualTimers, cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

describe("Second Brain launcher and handshake", () => {
  it("publishes exact production constants and launches a frozen target with argv and minimal env", async () => {
    const value = fixture(); const launches: Array<{ file: string; args: readonly string[]; options: SecondBrainExecFileOptions }> = [];
    const runner: SecondBrainExecFile = (file, args, childOptions) => { launches.push({ file, args, options: childOptions }); return execFile(file, [...args], childOptions); };
    const transport = createSecondBrainTransport(options(value, { execFile: runner })); transports.push(transport);
    await expect(transport.call("sb_open_conflicts", {})).resolves.toMatchObject({ kind: "data" });
    expect({ launcher: SECOND_BRAIN_LAUNCHER, config: SECOND_BRAIN_CONFIG, protocol: SECOND_BRAIN_PROTOCOL_VERSION, bytes: SECOND_BRAIN_FRAME_BYTES }).toEqual({ launcher: "/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp", config: "/home/jm/.config/second-brain/config.toml", protocol: "2026-07-28", bytes: 1_048_576 });
    expect(launches).toHaveLength(1); expect(launches[0]?.args).toEqual([]); expect(launches[0]?.options).toMatchObject({ shell: false, env: { SB_CONFIG: value.config }, windowsHide: true });
    expect(Object.keys(launches[0]?.options.env ?? {})).toEqual(["SB_CONFIG"]);
  });

  it("freezes a realpath per generation and discovers a symlink swap only after restart", async () => {
    const first = fixture(); const second = fixture(); const transport = createSecondBrainTransport(options(first)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "before" })).resolves.toMatchObject({ kind: "data" });
    rmSync(first.launcher); symlinkSync(second.launcher, first.launcher);
    await expect(transport.call("sb_search", { query: "still-running" })).resolves.toMatchObject({ kind: "data" });
    await transport.restart();
    await expect(transport.call("sb_search", { query: "new-generation" })).resolves.toMatchObject({ kind: "data" });
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_STARTED").map(item => item.generation)).toEqual([1, 2]);
  });

  it("rejects discovery, executable, protocol, tool schema, malformed, and oversize failures", async () => {
    const missing = fixture(); rmSync(missing.launcher); const absent = createSecondBrainTransport(options(missing)); transports.push(absent); await expect(absent.call("sb_search", { query: "x" })).rejects.toMatchObject({ code: "SECOND_BRAIN_DISCOVERY_FAILED" });
    const denied = fixture(); rmSync(denied.launcher); writeFileSync(denied.launcher, "not executable", { mode: 0o600 }); const executable = createSecondBrainTransport(options(denied)); transports.push(executable); await expect(executable.call("sb_search", { query: "x" })).rejects.toMatchObject({ code: "SECOND_BRAIN_START_FAILED" });
    for (const [settings, code] of [[{ protocolVersion: "wrong" }, "SECOND_BRAIN_VERSION_MISMATCH"], [{ badTools: true }, "SECOND_BRAIN_SCHEMA_MISMATCH"], [{ mode: "malformed" }, "SECOND_BRAIN_MALFORMED_FRAME"], [{ mode: "oversize" }, "SECOND_BRAIN_OVERSIZE_FRAME"]] as const) { const value = fixture(settings); const transport = createSecondBrainTransport(options(value)); transports.push(transport); await expect(transport.call("sb_search", { query: "x" })).rejects.toMatchObject({ code }); }
  });

  it("classifies the exact startup deadline", async () => {
    const value = fixture({ mode: "hang-initialize" }); const timers = new ManualTimers(); const transport = createSecondBrainTransport(options(value, { timers })); transports.push(transport);
    const startup = transport.call("sb_search", { query: "x" }); expect(timers.delays).toContain(5_000); timers.fireLatest();
    await expect(startup).rejects.toMatchObject({ code: "SECOND_BRAIN_STARTUP_TIMEOUT", disposition: "unavailable" }); expect(timers.count).toBe(0);
  });

  it("invalidates every failed startup generation before a later full handshake", async () => {
    const cases = [
      [{ mode: "hang-initialize" }, "SECOND_BRAIN_STARTUP_TIMEOUT", true],
      [{ mode: "hang-tools" }, "SECOND_BRAIN_STARTUP_TIMEOUT", true],
      [{ mode: "missing-server" }, "SECOND_BRAIN_MALFORMED_FRAME", false],
      [{ mode: "invalid-server" }, "SECOND_BRAIN_VERSION_MISMATCH", false],
      [{ badTools: true }, "SECOND_BRAIN_SCHEMA_MISMATCH", false],
      [{ mode: "malformed-tool" }, "SECOND_BRAIN_SCHEMA_MISMATCH", false],
    ] as const;
    for (const [settings, code, timed] of cases) {
      // Given: one executable generation with a specific invalid startup boundary.
      const value = fixture(settings); const timers = new ManualTimers(); let launches = 0;
      const runner: SecondBrainExecFile = (file, args, childOptions) => { launches += 1; return execFile(file, [...args], childOptions); };
      const transport = createSecondBrainTransport(options(value, { execFile: runner, timers })); transports.push(transport);
      // When: startup fails, then the fixture is repaired and called again.
      const failed = transport.call("sb_search", { query: "first" }); if (timed) timers.fireLatest();
      await expect(failed).rejects.toMatchObject({ code });
      writeFileSync(value.config, JSON.stringify({ control: value.control, receipt: value.receipt }));
      // Then: a fresh child completes initialize and tools/list before serving the call.
      await expect(transport.call("sb_search", { query: "second" })).resolves.toMatchObject({ kind: "data" });
      expect(launches).toBe(2);
      expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_STARTED")).toHaveLength(1);
    }
  });

  it("buffers partial frames and keeps injection-shaped arguments inert", async () => {
    const partial = fixture({ mode: "partial" }); const transport = createSecondBrainTransport(options(partial)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "$(touch /tmp/task10-injected);;" })).resolves.toMatchObject({ kind: "data" });
    expect(transport.diagnostics().every(item => !JSON.stringify(item).includes("task10-injected"))).toBe(true);
  });
});
