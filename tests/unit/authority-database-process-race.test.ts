import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, openSync, closeSync, readdirSync, statSync as realStatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `discoverOpenInodeHolders` walks real /proc entries, each of which can vanish between the
 * `readdirSync("/proc")` enumeration and the later reads that inspect one of them - a process
 * exiting mid-scan. That race is simulated here by making the underlying `statSync` throw for one
 * specific, synthetic pid injected into the /proc listing, the way a real vanished process would:
 * ENOENT (and, for parity with the ENOENT/ESRCH-is-absent rule used elsewhere for a PID that
 * exited, ESRCH) must be treated as the process simply being gone, not as an error that escapes
 * the scan; EACCES/EPERM must still fail closed into `unprovable`.
 */
const state = vi.hoisted((): {
  racingPid: number; racingCode: string; exitedPid: number; rootError: Error | undefined;
} => ({
  racingPid: 0, racingCode: "", exitedPid: 0, rootError: undefined,
}));

vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => {
      const [target, options] = args;
      if (target === "/proc") {
        if (state.rootError !== undefined) throw state.rootError;
        if (state.exitedPid !== 0) {
          // Node resolves UNKNOWN Dirents with lstat before returning the listing. Preserve that
          // boundary using the real filesystem and a PID whose close event has already arrived.
          if (typeof options === "object" && options !== null
            && Reflect.get(options, "withFileTypes") === true) {
            real.lstatSync(`/proc/${state.exitedPid}`);
          }
          return [String(state.exitedPid)];
        }
      }
      const result = real.readdirSync(...args);
      if (state.racingPid !== 0 && target === "/proc" && options === undefined) {
        return [...result, String(state.racingPid)];
      }
      if (state.racingPid !== 0 && target === "/proc" && typeof options === "object" && options !== null
        && "withFileTypes" in options && (options as { withFileTypes?: boolean }).withFileTypes === true) {
        const synthetic = {
          name: String(state.racingPid), isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
        };
        return [...(result as unknown[]), synthetic];
      }
      return result;
    },
    statSync: (...args: Parameters<typeof real.statSync>) => {
      const [target] = args;
      if (state.racingPid !== 0 && typeof target === "string" && target === `/proc/${state.racingPid}`) {
        const error = new Error(`${state.racingCode}: racing pid gone, stat '${target}'`) as NodeJS.ErrnoException;
        error.code = state.racingCode;
        error.syscall = "stat";
        throw error;
      }
      return real.statSync(...args);
    },
  };
});

const { discoverOpenInodeHolders, effectiveUserId, ProcessObservationError } =
  await import("../../src/authority-database-process.js");
type OpenInodeObservation = ReturnType<typeof discoverOpenInodeHolders>;

describe("discoverOpenInodeHolders / process vanished mid-scan", () => {
  let dir: string | undefined;
  afterEach(() => {
    state.racingPid = 0; state.racingCode = ""; state.exitedPid = 0; state.rootError = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function targetInode(): { device: bigint; inode: bigint } {
    dir = mkdtempSync(join(tmpdir(), "jarvis-proc-race-"));
    const path = join(dir, "target");
    const fd = openSync(path, "w");
    closeSync(fd);
    const stat = realStatSync(path, { bigint: true });
    return { device: stat.dev, inode: stat.ino };
  }

  function injectRacingPid(code: string): number {
    const racingPid = Number.MAX_SAFE_INTEGER;
    state.racingPid = racingPid; state.racingCode = code;
    return racingPid;
  }

  it.each(["ENOENT", "ESRCH"])(
    "does not throw when a racing pid's /proc entry disappears (%s), and excludes it from holders",
    code => {
      const { device, inode } = targetInode();
      const racingPid = injectRacingPid(code);
      let observed: OpenInodeObservation | undefined;
      expect(() => { observed = discoverOpenInodeHolders(device, inode); }).not.toThrow();
      expect(observed!.holders.some(h => h.pid === racingPid)).toBe(false);
      expect(observed!.unprovable).not.toContain(racingPid);
    },
  );

  it.each(["EACCES", "EPERM"])(
    "fails closed into `unprovable` rather than throwing when a racing pid is unreadable (%s)",
    code => {
      const { device, inode } = targetInode();
      const racingPid = injectRacingPid(code);
      let observed: OpenInodeObservation | undefined;
      expect(() => { observed = discoverOpenInodeHolders(device, inode); }).not.toThrow();
      expect(observed!.unprovable).toContain(racingPid);
    },
  );

  it("still throws for an error that is neither an absence nor a permission failure", () => {
    const { device, inode } = targetInode();
    injectRacingPid("EIO");
    expect(() => discoverOpenInodeHolders(device, inode)).toThrow(ProcessObservationError);
  });

  it("treats a real process that exits after enumeration as absent before Dirent conversion", async () => {
    const { device, inode } = targetInode();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    const closed = once(child, "close", { signal: AbortSignal.timeout(3_000) });
    try {
      await once(child, "spawn", { signal: AbortSignal.timeout(3_000) });
      const pid = child.pid;
      if (pid === undefined) throw new Error("child did not acquire a PID");
      expect(readdirSync("/proc")).toContain(String(pid));
      child.stdin.end();
      expect(await closed).toEqual([0, null]);
      state.exitedPid = pid;
      const observed = discoverOpenInodeHolders(device, inode);
      expect(observed.holders).toEqual([]);
      expect(observed.writable_holders).toEqual([]);
      expect(observed.unprovable).toEqual([]);
      expect(observed.fd_count).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const cleanup = once(child, "close", { signal: AbortSignal.timeout(3_000) });
        child.kill();
        await cleanup;
      }
    }
  });

  it.each(["ENOENT", "ESRCH", "EIO", "EACCES"])(
    "still throws when the root process listing itself fails (%s)",
    code => {
      const { device, inode } = targetInode();
      const error = Object.assign(new Error("root process listing failed"), { code });
      state.rootError = error;
      expect(() => discoverOpenInodeHolders(device, inode)).toThrow(error);
    },
  );

  it("sanity: effectiveUserId matches the running user", () => {
    expect(effectiveUserId()).toBe(process.geteuid?.());
  });
});
