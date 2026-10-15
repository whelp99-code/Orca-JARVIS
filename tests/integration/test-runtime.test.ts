import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
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
