import { mkdtempSync, openSync, closeSync, statSync as realStatSync, rmSync } from "node:fs";
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
const state = vi.hoisted(() => ({
  racingPid: 0 as number, racingCode: "" as string,
}));

vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readdirSync: (...args: Parameters<typeof real.readdirSync>) => {
      const [target, options] = args;
      const result = real.readdirSync(...args);
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
    state.racingPid = 0; state.racingCode = "";
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
    const racingPid = 900000 + Math.floor(Math.random() * 90000);
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

  it("sanity: effectiveUserId matches the running user", () => {
    expect(effectiveUserId()).toBe(process.geteuid?.());
  });
});
