import { execFile } from "node:child_process"; import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join, resolve } from "node:path"; import { afterEach, describe, expect, it } from "vitest"; import { secondBrainConfig,
  SECOND_BRAIN_FRAME_BYTES, secondBrainLauncher, SECOND_BRAIN_PROTOCOL_VERSION, createSecondBrainTransport, type SecondBrainExecFile,
  type SecondBrainExecFileOptions, } from "../../src/second-brain-transport.js";
import { ManualTimers, cleanupFixtures, fixture, options } from "../fixtures/second-brain-transport-harness.js";
const transports: Array<{ close(): Promise<void> }> = []; afterEach(async () => { await Promise.all(transports.splice(0).map((item) => item.close()));
  cleanupFixtures(); }); describe("Second Brain launcher and handshake", () => {
  it("publishes exact production constants and launches a frozen target with argv and minimal env", async () => { const value = fixture();
    const launches: Array<{ file: string; args: readonly string[]; options: SecondBrainExecFileOptions }> = [];
    const runner: SecondBrainExecFile = (file, args, childOptions) => { launches.push({ file, args, options: childOptions });
      return execFile(file, [...args], childOptions); }; const transport = createSecondBrainTransport(options(value, { execFile: runner }));
    transports.push(transport); await expect(transport.call("sb_open_conflicts", {})).resolves.toMatchObject({ kind: "data" });
    const saved = {
      JARVIS_PROVIDER_STATE_ROOT: process.env["JARVIS_PROVIDER_STATE_ROOT"],
      JARVIS_SECOND_BRAIN_LAUNCHER: process.env["JARVIS_SECOND_BRAIN_LAUNCHER"],
      JARVIS_SECOND_BRAIN_CONFIG: process.env["JARVIS_SECOND_BRAIN_CONFIG"],
    };
    delete process.env["JARVIS_PROVIDER_STATE_ROOT"];
    delete process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
    delete process.env["JARVIS_SECOND_BRAIN_CONFIG"];
    try {
      expect({ launcher: secondBrainLauncher(), config: secondBrainConfig(), protocol: SECOND_BRAIN_PROTOCOL_VERSION, bytes: SECOND_BRAIN_FRAME_BYTES }).toEqual({
        launcher: "/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp", config: "/home/jm/.config/second-brain/config.toml",
        protocol: "2025-11-25", bytes: 1_048_576, });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    } expect(launches).toHaveLength(1); expect(launches[0]?.args).toEqual([]);
    expect(launches[0]?.options).toMatchObject({ shell: false, env: { SB_CONFIG: value.config, SB_MCP_CONTRACT_PROFILE: "task32-schema4" }, windowsHide: true,
    }); expect(Object.keys(launches[0]?.options.env ?? {}).sort()).toEqual(["SB_CONFIG", "SB_MCP_CONTRACT_PROFILE"]); });
  it("freezes a realpath per generation and discovers a symlink swap only after restart", async () => { const first = fixture(); const second = fixture();
    const transport = createSecondBrainTransport(options(first)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "before" })).resolves.toMatchObject({ kind: "data" }); rmSync(first.launcher);
    symlinkSync(second.launcher, first.launcher);
    await expect(transport.call("sb_search", { query: "still-running" })).resolves.toMatchObject({ kind: "data" }); await transport.restart();
    await expect(transport.call("sb_search", { query: "new-generation" })).resolves.toMatchObject({ kind: "data" }); expect( transport .diagnostics()
        .filter((item) => item.code === "SECOND_BRAIN_STARTED") .map((item) => item.generation), ).toEqual([1, 2]); });
  it("rejects discovery, executable, protocol, tool schema, malformed, and oversize failures", async () => { const missing = fixture();
    rmSync(missing.launcher); const absent = createSecondBrainTransport(options(missing)); transports.push(absent);
    await expect(absent.call("sb_search", { query: "x" })).rejects.toMatchObject({ code: "SECOND_BRAIN_DISCOVERY_FAILED" }); const denied = fixture();
    rmSync(denied.launcher); writeFileSync(denied.launcher, "not executable", { mode: 0o600 }); const executable = createSecondBrainTransport(options(denied));
    transports.push(executable); await expect(executable.call("sb_search", { query: "x" })).rejects.toMatchObject({ code: "SECOND_BRAIN_START_FAILED" });
    for (const [settings, code] of [ [{ protocolVersion: "wrong" }, "SECOND_BRAIN_VERSION_MISMATCH"], [{ badTools: true }, "SECOND_BRAIN_SCHEMA_MISMATCH"],
      [{ mode: "malformed" }, "SECOND_BRAIN_MALFORMED_FRAME"], [{ mode: "oversize" }, "SECOND_BRAIN_OVERSIZE_FRAME"], ] as const) {
      const value = fixture(settings); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
      await expect(transport.call("sb_search", { query: "x" })).rejects.toMatchObject({ code }); } });
  it("rejects every negotiated version other than the measured producer version before tools/call", async () => {
    const value = fixture({ protocolVersion: "2026-07-28" }); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "never" })).rejects.toMatchObject({ code: "SECOND_BRAIN_VERSION_MISMATCH", disposition: "fatal",
      generation: 1, }); expect(readFileSync(value.receipt, "utf8")).toBe("");
    expect(transport.diagnostics().filter((item) => item.code === "SECOND_BRAIN_REQUESTED" && item.method === "sb_search")).toHaveLength(0);
    await transport.close(); expect(transport.diagnostics().at(-1)).toMatchObject({ code: "SECOND_BRAIN_CLOSED", pending_count: 0, queued_count: 0,
      correlation_count: 0, listener_count: 0, timer_count: 0, }); }); it("classifies the exact startup deadline", async () => {
    const value = fixture({ mode: "hang-initialize" }); const timers = new ManualTimers();
    const transport = createSecondBrainTransport(options(value, { timers })); transports.push(transport);
    const startup = transport.call("sb_search", { query: "x" }); expect(timers.delays).toContain(5_000); timers.fireLatest();
    await expect(startup).rejects.toMatchObject({ code: "SECOND_BRAIN_STARTUP_TIMEOUT", disposition: "unavailable" }); expect(timers.count).toBe(0); });
  it("invalidates every failed startup generation before a later full handshake", async () => { const cases = [
      [{ mode: "hang-initialize" }, "SECOND_BRAIN_STARTUP_TIMEOUT", true], [{ mode: "hang-tools" }, "SECOND_BRAIN_STARTUP_TIMEOUT", true],
      [{ mode: "missing-server" }, "SECOND_BRAIN_MALFORMED_FRAME", false], [{ mode: "invalid-server" }, "SECOND_BRAIN_VERSION_MISMATCH", false],
      [{ badTools: true }, "SECOND_BRAIN_SCHEMA_MISMATCH", false], [{ mode: "malformed-tool" }, "SECOND_BRAIN_SCHEMA_MISMATCH", false], ] as const;
    for (const [settings, code, timed] of cases) {
      // Given: one executable generation with a specific invalid startup boundary.
      const value = fixture(settings); const timers = new ManualTimers(); let launches = 0; const runner: SecondBrainExecFile = (file, args, childOptions) => {
        launches += 1; return execFile(file, [...args], childOptions); };
      const transport = createSecondBrainTransport(options(value, { execFile: runner, timers })); transports.push(transport);
      // When: startup fails, then the fixture is repaired and called again.
      const failed = transport.call("sb_search", { query: "first" }); if (timed) timers.fireLatest(); await expect(failed).rejects.toMatchObject({ code });
      writeFileSync(value.config, JSON.stringify({ control: value.control, receipt: value.receipt }));
      // Then: a fresh child completes initialize and tools/list before serving the call.
      await expect(transport.call("sb_search", { query: "second" })).resolves.toMatchObject({ kind: "data" }); expect(launches).toBe(2);
      expect(transport.diagnostics().filter((item) => item.code === "SECOND_BRAIN_STARTED")).toHaveLength(1); } });
  it("loads the shipped contract from unrelated cwd without discovering any installed launcher", async () => {
    // Given: a run-owned executable/config and a discovery guard, even if production is installed.
    const cwd = process.cwd();
    const value = fixture({ contractPath: resolve("contracts/second-brain-mcp-v1.json") });
    const discoveries: string[] = [];
    const transport = createSecondBrainTransport(options(value, { realpath: path => {
      discoveries.push(path);
      if (path !== value.launcher) throw new Error("PRODUCTION_LAUNCHER_DISCOVERY_FORBIDDEN");
      return realpathSync(path);
    } }));
    transports.push(transport);
    process.chdir(tmpdir());
    try {
      // When: a real handshake and request run outside the repository.
      await expect(transport.call("sb_search", { query: "synthetic" })).resolves.toMatchObject({ kind: "data" });
      // Then: only the injected executable was discovered and executed.
      expect(discoveries).toEqual([value.launcher]);
    } finally { process.chdir(cwd); }
    const root = mkdtempSync(join(tmpdir(), "second-brain-contract-tamper-")); const contract = join(root, "contract.json");
    copyFileSync("contracts/second-brain-mcp-v1.json", contract); copyFileSync("contracts/second-brain-mcp-v1.json.sha256", `${contract}.sha256`);
    const bytes = readFileSync(contract); bytes[0] = bytes[0] === 123 ? 91 : 123; writeFileSync(contract, bytes);
    expect(() => createSecondBrainTransport(options(value, { contractPath: contract }))).toThrowError("SECOND_BRAIN_CONTRACT_MISMATCH");
    copyFileSync("contracts/second-brain-mcp-v1.json", contract); rmSync(`${contract}.sha256`);
    expect(() => createSecondBrainTransport(options(value, { contractPath: contract }))).toThrowError("SECOND_BRAIN_CONTRACT_MISMATCH");
    rmSync(root, { recursive: true, force: true }); }); it("buffers partial frames and keeps injection-shaped arguments inert", async () => {
    const partial = fixture({ mode: "partial" }); const transport = createSecondBrainTransport(options(partial)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "$(touch /tmp/task10-injected);;" })).resolves.toMatchObject({ kind: "data" });
    expect(transport.diagnostics().every((item) => !JSON.stringify(item).includes("task10-injected"))).toBe(true); }); });
