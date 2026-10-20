import { readFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestEnvironment } from "../../scripts/lib/test-environment.mjs";
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

describe("provider storage selector", () => {
  it("keeps ordinary temporary behavior when the call does not set the selector", () => {
    const scratch = createTestEnvironment({});
    try { expect(dirname(scratch.root)).toBe(tmpdir()); }
    finally { scratch.cleanup(); }
    expect(existsSync(scratch.root)).toBe(false);
    expect(() => createTestEnvironment({ TMPDIR: "/proc/jarvis-test-invalid" })).toThrow("TEST_TMPDIR_UNAVAILABLE");
    expect(() => createTestEnvironment({ TMPDIR: "relative-path" })).toThrow("TEST_TMPDIR_UNAVAILABLE");
  });

  it("places the scratch under the selector and gives the child that directory", () => {
    const base = realpathSync(requiredStorage());
    const scratch = createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: base, TMPDIR: tmpdir() });
    try {
      expect(scratch.root.startsWith(base + sep)).toBe(true);
      expect(scratch.env.TMPDIR).toBe(scratch.root);
      expect(scratch.env.TMP).toBe(scratch.root);
      expect(scratch.env.TEMP).toBe(scratch.root);
      expect(scratch.env.JARVIS_TEST_PROVIDER_STORAGE_ROOT).toBe(scratch.root);
      const child = spawnSync(process.execPath, ["-p", "require('node:os').tmpdir()"], { env: scratch.env, encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe(scratch.root);
    } finally { scratch.cleanup(); }
  });

  it("keeps a nested scratch inside the parent root", () => {
    const base = mkdtempSync(join(realpathSync(requiredStorage()), "caller-"));
    const marker = join(base, "sibling");
    writeFileSync(marker, "keep", { mode: 0o600 });
    const parent = createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: base, TMPDIR: tmpdir() });
    try {
      expect(parent.root.startsWith(base + sep)).toBe(true);
      const child = createTestEnvironment(parent.env);
      expect(dirname(child.root)).toBe(parent.root);
      expect(child.root.startsWith(parent.root + sep)).toBe(true);
      child.cleanup();
      expect(existsSync(child.root)).toBe(false);
      expect(existsSync(parent.root)).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      parent.cleanup();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects an empty, relative, missing, file, or symlink selector without leaving the caller base", () => {
    const sentinel = mkdtempSync(join(tmpdir(), "jarvis-sentinel-"));
    const marker = join(sentinel, "sibling");
    writeFileSync(marker, "keep", { mode: 0o600 });
    const file = join(sentinel, "file");
    writeFileSync(file, "x", { mode: 0o600 });
    const link = join(sentinel, "link");
    symlinkSync(sentinel, link);
    const reject = (selector: string, message: string) => {
      expect(() => createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: selector, TMPDIR: sentinel })).toThrow(message);
      expect(readdirSync(sentinel).sort()).toEqual(["file", "link", "sibling"]);
    };
    try {
      reject("", "TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
      reject("   ", "TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
      reject("relative-path", "TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
      expect(() => createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: "/proc/jarvis-storage-missing", TMPDIR: sentinel }))
        .toThrow(expect.objectContaining({ message: "TEST_TMPDIR_UNAVAILABLE", cause: "ENOENT" }));
      reject(file, "TEST_PROVIDER_STORAGE_UNSUPPORTED");
      reject(link, "TEST_PROVIDER_STORAGE_UNSUPPORTED");
    } finally { rmSync(sentinel, { recursive: true, force: true }); }
  });

  it("rejects a real btrfs run directory before any provider process starts", () => {
    const base = mkdtempSync(join(homedir(), "jarvis-btrfs-storage-"));
    writeFileSync(join(base, "sibling"), "keep", { mode: 0o600 });
    try {
      expect(statfsSync(base).type).toBe(0x9123683e);
      expect(lstatSync(base).nlink).toBe(1);
      let caught: unknown;
      try { createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: base, TMPDIR: tmpdir() }); }
      catch (error) { caught = error; }
      expect(caught).toMatchObject({
        message: "TEST_PROVIDER_STORAGE_UNSUPPORTED", reason: "nlink_below_2",
        metadata: { nlink: 1, is_directory: true, is_symlink: false, uid_matches: true },
      });
      expect(readdirSync(base)).toEqual(["sibling"]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("accepts a private tmpfs directory that meets the provider predicate", () => {
    const base = realpathSync(requiredStorage());
    const info = lstatSync(base);
    expect(statfsSync(base).type).toBe(0x01021994);
    expect(info.isSymbolicLink()).toBe(false);
    expect(info.isDirectory()).toBe(true);
    expect(info.uid).toBe(currentUid());
    expect(info.nlink).toBeGreaterThanOrEqual(2);
    const marker = join(base, "sibling-marker");
    writeFileSync(marker, "keep", { flag: "wx", mode: 0o600 });
    const scratch = createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: base, TMPDIR: tmpdir() });
    try {
      expect(scratch.root.startsWith(base + sep)).toBe(true);
      expect(statSync(scratch.root).mode & 0o777).toBe(0o700);
      expect(scratch.env.TMPDIR).toBe(scratch.root);
      const child = spawnSync(process.execPath, ["-p", "require('node:os').tmpdir()"], { env: scratch.env, encoding: "utf8" });
      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe(scratch.root);
    } finally {
      scratch.cleanup();
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
    }
    expect(existsSync(scratch.root)).toBe(false);
    expect(existsSync(base)).toBe(true);
  });

  it("rejects a directory owned by another user before creating a run directory", () => {
    const sentinel = mkdtempSync(join(tmpdir(), "jarvis-owner-sentinel-"));
    const before = readdirSync("/usr");
    try {
      expect(lstatSync("/usr").isSymbolicLink()).toBe(false);
      expect(lstatSync("/usr").uid).not.toBe(currentUid());
      expect(() => createTestEnvironment({ JARVIS_TEST_PROVIDER_STORAGE_ROOT: "/usr", TMPDIR: sentinel })).toThrow(expect.objectContaining({
        message: "TEST_PROVIDER_STORAGE_UNSUPPORTED", reason: "owner_mismatch",
      }));
      expect(readdirSync("/usr")).toEqual(before);
      expect(readdirSync(sentinel)).toEqual([]);
    } finally { rmSync(sentinel, { recursive: true, force: true }); }
  });
});

function currentUid(): number {
  const getuid = process.getuid;
  if (getuid === undefined) throw new Error("TEST_UID_UNAVAILABLE");
  return getuid();
}

function requiredStorage(): string {
  const storage = process.env["JARVIS_TEST_PROVIDER_STORAGE_ROOT"];
  expect(storage, "private supported storage was not provided").toBeTruthy();
  return storage!;
}
