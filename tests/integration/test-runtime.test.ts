import { afterEach, describe, expect, it, vi } from "vitest";

const nodeFs = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
}));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  nodeFs.lstatSync = vi.fn(real.lstatSync);
  nodeFs.realpathSync = vi.fn(real.realpathSync);
  return { ...real, lstatSync: nodeFs.lstatSync, realpathSync: nodeFs.realpathSync };
});
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createTestEnvironment, providerStorageBase } from "../../scripts/lib/test-environment.mjs";
import { runTestProcess } from "../../scripts/lib/test-process.mjs";

function running(pid: number): boolean {
  try { return !["Z", "X"].includes(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!); }
  catch (error) {
    // /proc can disappear after open but before read when the process exits.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}

const providerRoot = "/var/jarvis-provider-storage-fixture";

function statFixture(overrides: Partial<import("node:fs").Stats> & Pick<import("node:fs").Stats, "isDirectory" | "isSymbolicLink" | "nlink" | "mode">): import("node:fs").Stats {
  return {
    uid: process.getuid?.() ?? 0,
    ...overrides,
  } as import("node:fs").Stats;
}

describe("test runtime lifecycle", () => {
  it("places unconfigured scratch on the OS temporary filesystem", () => {
    const scratch = createTestEnvironment({});
    try {
      expect(dirname(scratch.root)).toBe(tmpdir());
      expect(scratch.env.TMPDIR).toBe(scratch.root);
      expect(statSync(scratch.root).mode & 0o777).toBe(0o700);
    } finally {
      scratch.cleanup();
    }
    expect(existsSync(scratch.root)).toBe(false);
  });

  it("creates an isolated verified scratch root and removes only its own files", () => {
    const parent = createTestEnvironment();
    try {
      const child = createTestEnvironment({ TMPDIR: parent.root });
      expect(child.env.TMPDIR).toBe(child.root); expect(child.root).not.toBe(parent.root);
      expect(statSync(child.root).mode & 0o777).toBe(0o700);
      child.cleanup(); expect(existsSync(child.root)).toBe(false); expect(existsSync(parent.root)).toBe(true);
    } finally { parent.cleanup(); }
  });

  it("rejects an unusable explicit temporary location instead of falling back", () => {
    expect(() => createTestEnvironment({ TMPDIR: "/proc/jarvis-test-invalid" })).toThrow("TEST_TMPDIR_UNAVAILABLE");
    expect(() => createTestEnvironment({ TMPDIR: "relative-path" })).toThrow("TEST_TMPDIR_UNAVAILABLE");
  });

  it("reports missing commands and deadline expiry without claiming success", async () => {
    expect(await runTestProcess("/definitely/missing", [], { forward: false })).toMatchObject({ spawnError: "ENOENT" });
    const result = await runTestProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100, forward: false });
    expect(result).toMatchObject({ timedOut: true, code: null, signal: "SIGTERM" });
  });

  it("bounds startup separately and honours cancellation", async () => {
    const startup = await runTestProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 10000, startupTimeoutMs: 100, readyMarker: "READY", forward: false });
    expect(startup.timedOut).toBe(true);
    const controller = new AbortController(); controller.abort();
    expect(await runTestProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { signal: controller.signal, forward: false })).toMatchObject({ interrupted: true });
  });

  it.skipIf(process.platform !== "linux")("reaps a stubborn grandchild even after the parent exits successfully", async () => {
    const childSource = "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000);";
    const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],
      {stdio:['ignore','pipe','pipe']}); child.stdout.once('data',data=>{process.stdout.write(data);process.exit(0)});`;
    const result = await runTestProcess(process.execPath, ["-e", source], { timeoutMs: 5000, forward: false });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    const pid = Number(result.output.trim()); expect(pid).toBeGreaterThan(0); expect(running(pid)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("cleans nested groups before an existing owner signal handler exits", async () => {
    const helper = new URL("../../scripts/lib/test-process.mjs", import.meta.url).href;
    const childSource = "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000);";
    const source = `import {runTestProcess} from ${JSON.stringify(helper)};
      process.on('SIGTERM',()=>process.exit(143));
      await runTestProcess(process.execPath,['-e',${JSON.stringify(childSource)}]);`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(owner, "close");
    let pid: number | undefined;
    try {
      const [data] = await once(owner.stdout, "data");
      pid = Number(String(data).trim()); expect(pid).toBeGreaterThan(0);
      owner.kill("SIGTERM");
      expect((await closed)[0]).toBe(143);
      expect(running(pid)).toBe(false);
    } finally {
      owner.kill("SIGTERM");
      if (pid && running(pid)) process.kill(-pid, "SIGKILL");
      await closed;
    }
  });

  it.skipIf(process.platform !== "linux").each(["SIGTERM", "SIGINT"] as const)("cleans nested detached groups when the outer runner receives %s", async signal => {
    const helper = new URL("../../scripts/lib/test-process.mjs", import.meta.url).href;
    const leaf = "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000);";
    const inner = `import {runTestProcess} from ${JSON.stringify(helper)};
      process.on('SIGTERM',()=>process.exit(143));
      await runTestProcess(process.execPath,['-e',${JSON.stringify(leaf)}]);`;
    const outer = `import {runTestProcess} from ${JSON.stringify(helper)};
      const controller=new AbortController();
      process.once('SIGTERM',()=>controller.abort()); process.once('SIGINT',()=>controller.abort());
      const result=await runTestProcess(process.execPath,['--input-type=module','-e',${JSON.stringify(inner)}],{signal:controller.signal});
      process.exitCode=result.interrupted?130:1;`;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", outer], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(owner, "close");
    let pid: number | undefined;
    try {
      const [data] = await once(owner.stdout, "data");
      pid = Number(String(data).trim()); expect(pid).toBeGreaterThan(0);
      owner.kill(signal);
      expect((await closed)[0]).toBe(130); expect(running(pid)).toBe(false);
    } finally {
      owner.kill("SIGTERM");
      if (pid && running(pid)) process.kill(-pid, "SIGKILL");
      await closed;
    }
  });
});
describe("provider storage base", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the operating-system temporary directory when the selector is absent", () => {
    expect(providerStorageBase({})).toBe(tmpdir());
  });

  it("resolves an absolute directory fixture with nlink 2", () => {
    const info = statFixture({ isDirectory: () => true, isSymbolicLink: () => false, nlink: 2, mode: 0o40700 });
    vi.mocked(nodeFs.lstatSync).mockReturnValue(info);
    vi.mocked(nodeFs.realpathSync).mockReturnValue("/resolved/provider-storage");
    expect(providerStorageBase({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: providerRoot })).toBe("/resolved/provider-storage");
    expect(nodeFs.lstatSync).toHaveBeenCalledWith(providerRoot);
  });

  it("refuses a directory fixture whose nlink is below 2 and reports mode", () => {
    const info = statFixture({ isDirectory: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o40755 });
    vi.mocked(nodeFs.lstatSync).mockReturnValue(info);
    const realpath = vi.mocked(nodeFs.realpathSync);
    expect(() => providerStorageBase({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: providerRoot })).toThrow(expect.objectContaining({
      message: "TEST_PROVIDER_STORAGE_UNSUPPORTED",
      reason: "nlink_below_2",
      metadata: { nlink: 1, is_directory: true, is_symlink: false, uid_matches: true, mode: 0o755 },
    }));
    expect(realpath).not.toHaveBeenCalled();
  });

  it("refuses a symlink fixture before resolving it", () => {
    const info = statFixture({ isDirectory: () => false, isSymbolicLink: () => true, nlink: 1, mode: 0o120777 });
    vi.mocked(nodeFs.lstatSync).mockReturnValue(info);
    const realpath = vi.mocked(nodeFs.realpathSync);
    expect(() => providerStorageBase({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: providerRoot })).toThrow(expect.objectContaining({
      message: "TEST_PROVIDER_STORAGE_UNSUPPORTED",
      reason: "symlink",
      metadata: { nlink: 1, is_directory: false, is_symlink: true, uid_matches: true, mode: 0o777 },
    }));
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects an empty or relative selector without stating the path", () => {
    const lstat = vi.mocked(nodeFs.lstatSync);
    expect(() => providerStorageBase({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: "  " })).toThrow("TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
    expect(() => providerStorageBase({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: "relative/provider" })).toThrow("TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe("suite storage selector", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("places the entire child temporary environment under the selected private root", () => {
    const parent = createTestEnvironment({});
    const info = statFixture({ isDirectory: () => true, isSymbolicLink: () => false, nlink: 2, mode: 0o40700 });
    vi.mocked(nodeFs.lstatSync).mockReturnValue(info);
    vi.mocked(nodeFs.realpathSync).mockReturnValue(parent.root);
    try {
      const child = createTestEnvironment({ TMPDIR: "/proc/not-used", JARVIS_TEST_PROVIDER_STORAGE_ROOT: parent.root });
      try {
        expect(dirname(child.root)).toBe(parent.root);
        expect(child.env).toMatchObject({ TMPDIR: child.root, TMP: child.root, TEMP: child.root,
          JARVIS_TEST_PROVIDER_STORAGE_ROOT: child.root });
        expect(statSync(child.root).mode & 0o777).toBe(0o700);
      } finally { child.cleanup(); }
      expect(existsSync(parent.root)).toBe(true);
    } finally { parent.cleanup(); }
  });

  it("rejects an unsupported created root and cleans only that root", () => {
    const parent = createTestEnvironment({});
    const info = statFixture({ isDirectory: () => true, isSymbolicLink: () => false, nlink: 2, mode: 0o40700 });
    vi.mocked(nodeFs.lstatSync).mockReturnValueOnce(info).mockReturnValueOnce({ ...info, nlink: 1 });
    vi.mocked(nodeFs.realpathSync).mockReturnValue(parent.root);
    try {
      expect(() => createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: parent.root })).toThrow(
        expect.objectContaining({ message: "TEST_PROVIDER_STORAGE_UNSUPPORTED", reason: "nlink_below_2" }));
      const created = String(vi.mocked(nodeFs.lstatSync).mock.calls[1]![0]);
      expect(existsSync(created)).toBe(false);
      expect(existsSync(parent.root)).toBe(true);
    } finally { parent.cleanup(); }
  });

  it("rejects invalid selectors instead of falling back to TMPDIR", () => {
    for (const selector of ["", "relative/provider"]) {
      expect(() => createTestEnvironment({ TMPDIR: tmpdir(), JARVIS_TEST_PROVIDER_STORAGE_ROOT: selector }))
        .toThrow("TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
    }
    expect(nodeFs.lstatSync).not.toHaveBeenCalled();
  });
});
