import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrcaReadRunner, resolveOrcaReadExecutable } from "../../src/orca-read-runner.js";
import { parseOrcaReadPayload } from "../../src/orca-read-envelope.js";

const roots: string[] = [];
const scratch = (): string => { const root = mkdtempSync(join(tmpdir(), "orca-read-")); roots.push(root); return root; };
function killFixture(root: string): void {
  for (const name of ["parent.pid", "descendant.pid"]) {
    if (!existsSync(join(root, name))) continue;
    const pid = Number(readFileSync(join(root, name), "utf8"));
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
}
afterEach(() => { for (const root of roots.splice(0)) { killFixture(root); rmSync(root, { recursive: true, force: true }); } });
const fixture = resolve("tests/fixtures/orca-read-child.mjs");
const rejection = (code: string): string => JSON.stringify({ ok: false, error: { code, message: "secret-error-text" } });

describe("bounded Orca read processes", () => {
  it("resolves Linux, development and explicit executable configuration without shell splitting", () => {
    expect(resolveOrcaReadExecutable({}, "linux")).toBe("orca-ide");
    expect(resolveOrcaReadExecutable({ ORCA_DEV_REPO_ROOT: "/dev" }, "linux")).toBe("orca-dev");
    expect(resolveOrcaReadExecutable({ ORCA_CLI_COMMAND: "/path with spaces/orca" })).toBe("/path with spaces/orca");
    for (const executable of ["", " orca", "orca\n", "orca\0"]) {
      expect(() => createOrcaReadRunner({ executable })).toThrow("ORCA_CLI_CONFIG_INVALID");
    }
    for (const timeoutMs of [0, 5001, NaN, 1.5]) expect(() => createOrcaReadRunner({ timeoutMs })).toThrow("ORCA_CLI_CONFIG_INVALID");
  });

  it.each([
    ["runtime_unavailable", "ORCA_CLI_UNAVAILABLE"], ["runtime_timeout", "ORCA_CLI_TIMEOUT"],
    ["permission_denied", "ORCA_PERMISSION_DENIED"], ["terminal_handle_stale", "ORCA_TERMINAL_STALE"],
  ])("preserves structured %s from both CLI exit paths", async (code, expected) => {
    const runner = createOrcaReadRunner({ executable: process.execPath });
    for (const exitCode of [0, 1]) await expect((async () => {
      const output = await runner(["-e", `process.stdout.write(${JSON.stringify(rejection(code))});process.exitCode=${exitCode};`]);
      return parseOrcaReadPayload(output);
    })()).rejects.toMatchObject({ code: expected, message: expected });
  });

  it("rejects success with a failed exit and refuses to classify stderr prose", async () => {
    const runner = createOrcaReadRunner({ executable: process.execPath });
    await expect(runner(["-e", 'process.stdout.write("{\\"ok\\":true,\\"result\\":{}}");process.exitCode=1;']))
      .rejects.toMatchObject({ code: "ORCA_CLI_EXIT_INVALID" });
    await expect(runner(["-e", `process.stderr.write(${JSON.stringify(rejection("runtime_timeout"))});process.exitCode=1;`]))
      .rejects.toMatchObject({ code: "ORCA_CLI_JSON_INVALID" });
  });

  it("keeps missing executables and denied execution fatal", async () => {
    const root = scratch();
    await expect(createOrcaReadRunner({ executable: join(root, "missing") })([])).rejects.toMatchObject({ code: "ORCA_CLI_NOT_INSTALLED" });
    const path = join(root, "denied"); writeFileSync(path, "not executable", { mode: 0o600 });
    await expect(createOrcaReadRunner({ executable: path })([])).rejects.toMatchObject({ code: "ORCA_PERMISSION_DENIED" });
  });

  it.each([["output", "ORCA_CLI_OUTPUT_LIMIT"], ["stderr", "ORCA_CLI_OUTPUT_LIMIT"], ["utf8", "ORCA_CLI_JSON_INVALID"]])(
    "bounds or rejects %s", async (mode, code) => {
      await expect(createOrcaReadRunner({ executable: process.execPath })([fixture, mode!, scratch()]))
        .rejects.toMatchObject({ code });
    },
  );

  it.skipIf(process.platform === "win32").each(["timeout", "descendant"])(
    "terminates %s even after the wrapper exits with a descendant holding stdout", async mode => {
      const root = scratch(); const started = performance.now();
      await expect(createOrcaReadRunner({ executable: process.execPath, timeoutMs: 500 })([fixture, mode, root]))
        .rejects.toMatchObject({ code: "ORCA_CLI_TIMEOUT" });
      expect(performance.now() - started).toBeLessThan(2000);
      const parent = Number(readFileSync(join(root, "parent.pid"), "utf8"));
      expect(() => process.kill(parent, 0)).toThrow();
      if (mode === "descendant" && process.platform === "linux") {
        const pid = readFileSync(join(root, "descendant.pid"), "utf8");
        // Pipe close precedes exit_notify/EXIT_ZOMBIE in Linux do_exit().
        // PF_EXITING (0x4) also proves entry into the non-returning kernel exit path;
        // a runnable task without that flag still fails. No timing delay or retry.
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const flags = Number(fields[6]); // /proc stat field 9, after pid and comm.
          expect(Number.isSafeInteger(flags)).toBe(true);
          expect(fields[0] === "Z" || (flags & 0x4) !== 0).toBe(true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["quiet-success", "quiet-error"])(
    "terminates descendants with separate stdio on %s", async mode => {
      const root = scratch(); const kill = vi.spyOn(process, "kill");
      try {
        const call = createOrcaReadRunner({ executable: process.execPath })([fixture, mode, root]);
        if (mode === "quiet-error") await expect(call).rejects.toMatchObject({ code: "ORCA_CLI_TIMEOUT" });
        else expect(parseOrcaReadPayload(await call)).toEqual({});
        const parent = Number(readFileSync(join(root, "parent.pid"), "utf8"));
        expect(kill).toHaveBeenCalledWith(-parent, "SIGKILL");
      } finally { kill.mockRestore(); }
    },
  );

  it.skipIf(process.platform === "win32")("bounds unconfirmed close and prevents another child launch", async () => {
    const root = scratch(); const runner = createOrcaReadRunner({ executable: process.execPath, timeoutMs: 500 });
    const started = performance.now();
    await expect(runner([fixture, "escaped", root])).rejects.toMatchObject({ code: "ORCA_CLI_CLEANUP_FAILED" });
    expect(performance.now() - started).toBeLessThan(2000);
    const parent = readFileSync(join(root, "parent.pid"), "utf8");
    await expect(runner([fixture, "timeout", root])).rejects.toMatchObject({ code: "ORCA_CLI_CLEANUP_FAILED" });
    expect(readFileSync(join(root, "parent.pid"), "utf8")).toBe(parent);
  });
});
