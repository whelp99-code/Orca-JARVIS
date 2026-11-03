import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedSecondBrainReadinessRunner } from "../../src/second-brain-readiness-runtime.js";
import { createSecondBrainTransport, type SecondBrainExecFile } from "../../src/second-brain-transport.js";

const LAUNCHER = "/opt/provider/bin/second-brain-mcp";

function asRoot(): void {
  vi.spyOn(process, "getuid").mockReturnValue(0);
}

function expectJmDrop(file: string, args: readonly string[]): void {
  expect(file).toBe("/usr/bin/sudo");
  expect(args.slice(0, 3)).toEqual(["-n", "-u", "jm"]);
}

function stubChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: () => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    },
  });
  return child;
}

describe("second brain child drop call path", () => {
  const saved = {
    launcher: process.env["JARVIS_SECOND_BRAIN_LAUNCHER"],
    config: process.env["JARVIS_SECOND_BRAIN_CONFIG"],
  };

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.launcher === undefined) delete process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
    else process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = saved.launcher;
    if (saved.config === undefined) delete process.env["JARVIS_SECOND_BRAIN_CONFIG"];
    else process.env["JARVIS_SECOND_BRAIN_CONFIG"] = saved.config;
  });

  it("status and doctor execFile is sudo -n -u jm when the caller is root", async () => {
    asRoot();
    process.env["JARVIS_SECOND_BRAIN_LAUNCHER"] = LAUNCHER;
    process.env["JARVIS_SECOND_BRAIN_CONFIG"] = "/opt/provider/config.toml";
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner = boundedSecondBrainReadinessRunner((file, args, _options, callback) => {
      calls.push({ file, args: [...args] });
      callback(null, "");
    });
    await runner.run("status");
    await runner.run("doctor");
    expect(calls).toHaveLength(2);
    expectJmDrop(calls[0]!.file, calls[0]!.args);
    expect(calls[0]!.args).toContain("status");
    expectJmDrop(calls[1]!.file, calls[1]!.args);
    expect(calls[1]!.args).toContain("doctor");
  });

  it("transport start uses the injected run and drops to jm when the caller is root", async () => {
    asRoot();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: SecondBrainExecFile = (file, args) => {
      calls.push({ file, args: [...args] });
      return stubChild();
    };
    const transport = createSecondBrainTransport({
      launcherPath: LAUNCHER,
      configPath: "/opt/provider/config.toml",
      realpath: path => path,
      deadlines: { startup: 50, read: 50, write: 50 },
      shutdownGraceMs: 20,
      safeReadRetries: 0,
      execFile,
    });
    await expect(transport.call("sb_open_conflicts", {})).rejects.toMatchObject({ code: "SECOND_BRAIN_CHILD_EXIT" });
    expect(calls).toHaveLength(1);
    expectJmDrop(calls[0]!.file, calls[0]!.args);
    expect(calls[0]!.args).toContain(LAUNCHER);
    await transport.close();
  });
});
