import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeTaskVerifierProcess, type TaskVerifierInvocation } from "../../src/task-verifier-process.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), realpath: vi.fn(), stat: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(),
  realpath: mocks.realpath, stat: mocks.stat }));
let child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn> };
let spawned: Promise<void>;
let sent: string;
beforeEach(() => {
  sent = ""; vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { pid: 987654, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) { sent += chunk.toString(); callback(); } }), kill: vi.fn() });
  spawned = new Promise(resolve => mocks.spawn.mockImplementation(() => { resolve(); return child; }));
  mocks.realpath.mockImplementation(async (path: string) => path);
  mocks.stat.mockResolvedValue({ isFile: () => true, mode: 0o600, uid: process.getuid?.(), nlink: 1, size: 128 });
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const input = (): TaskVerifierInvocation => ({ database: "/private/authority.sqlite", command: {} as TaskVerifierInvocation["command"],
  verification_id: "test-verification", timeout_ms: 1000, before_spawn: () => 500 });

it("uses the installed Node entry with an empty environment, bounded stdin and only a private key path", async () => {
  const runner = new NodeTaskVerifierProcess("/private/verifier.pem");
  const pending = runner.verify(input()); await spawned;
  expect(mocks.spawn).toHaveBeenCalledWith(process.execPath,
    [expect.stringMatching(/\/task-verifier-main\.js$/), "/private/authority.sqlite", "/private/verifier.pem"],
    { cwd: "/", env: {}, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  expect(JSON.parse(sent)).toEqual({ command: {}, verification_id: "test-verification" });
  child.stdout.write('{"invocation_id":"child"}'); child.emit("close", 0);
  await expect(pending).resolves.toEqual({ invocation_id: "child" });
});

it.each(["cancel", "elapsed"])("rejects %s during asynchronous executable preparation before spawning", async scenario => {
  const beforeSpawn = vi.fn(() => { if (scenario === "cancel") throw new Error("cancelled authority"); return 0; });
  const pending = new NodeTaskVerifierProcess("/private/verifier.pem").verify({ ...input(), before_spawn: beforeSpawn });
  await expect(pending).rejects.toThrow(scenario === "cancel" ? "cancelled authority" : "TASK_VERIFIER_TIMEOUT");
  expect(mocks.stat).toHaveBeenCalledTimes(3);
  expect(beforeSpawn).toHaveBeenCalledOnce(); expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each(["timeout", "output", "stdin"])("kills on %s and waits for process close before rejecting", async scenario => {
  vi.useFakeTimers();
  let settled = false;
  const pending = new NodeTaskVerifierProcess("/private/verifier.pem").verify(input());
  const observed = pending.then(() => { settled = true; }, () => { settled = true; });
  await spawned;
  if (scenario === "timeout") {
    await vi.advanceTimersByTimeAsync(499); expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
  }
  if (scenario === "output") child.stderr.write(Buffer.alloc(524288 + 4097));
  if (scenario === "stdin") child.stdin.emit("error", new Error("private diagnostic"));
  expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(settled).toBe(false);
  child.emit("close", null);
  await expect(pending).rejects.toThrow({ timeout: "TASK_VERIFIER_TIMEOUT", output: "TASK_VERIFIER_OUTPUT_LIMIT",
    stdin: "TASK_VERIFIER_INPUT_FAILED" }[scenario]);
  await observed;
});

it.each(["nonzero", "invalid_json", "spawn_error"])("sanitizes %s without returning raw child diagnostics", async scenario => {
  const pending = new NodeTaskVerifierProcess("/private/verifier.pem").verify(input()); await spawned;
  child.stderr.write("password=private-fixture-value");
  if (scenario === "invalid_json") child.stdout.write("not JSON password=private-fixture-value");
  if (scenario === "spawn_error") child.emit("error", new Error("password=private-fixture-value"));
  child.emit("close", scenario === "nonzero" ? 1 : 0);
  await expect(pending).rejects.toMatchObject({ message: { nonzero: "TASK_VERIFIER_FAILED",
    invalid_json: "TASK_VERIFIER_RESULT_INVALID", spawn_error: "TASK_VERIFIER_UNAVAILABLE" }[scenario] });
});

it.each(["permissions", "alias", "hardlink"])("reports %s as unavailable without spawning", async scenario => {
  if (scenario === "permissions") mocks.stat.mockResolvedValue({ isFile: () => true, mode: 0o644 });
  if (scenario === "alias") mocks.realpath.mockImplementation(async (path: string) => path === "/private/verifier.pem" ? "/elsewhere/key" : path);
  if (scenario === "hardlink") mocks.stat.mockResolvedValue({ isFile: () => true, mode: 0o600, uid: process.getuid?.(), nlink: 2, size: 128 });
  await expect(new NodeTaskVerifierProcess("/private/verifier.pem").checkReady()).rejects.toThrow("TASK_VERIFIER_UNAVAILABLE");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
