import { readdirSync, readFileSync, statSync } from "node:fs";

export type RegisteredAuthorityProcess = {
  readonly pid: number;
  readonly start_token: string;
};

export type OpenInodeObservation = {
  readonly holders: readonly RegisteredAuthorityProcess[];
  /** Holders with at least one descriptor that can write. A reader cannot lose a write. */
  readonly writable_holders: readonly RegisteredAuthorityProcess[];
  readonly fd_count: number;
  /**
   * Processes of this user whose descriptors could not be read, so this observation says nothing
   * about them. A replacement that needs to know nobody else holds the file cannot be decided
   * while this is non-empty; a report can be.
   */
  readonly unprovable: readonly number[];
};

export function effectiveUserId(): number {
  const getId = process.geteuid;
  if (getId === undefined) throw new ProcessObservationError(process.pid);
  return getId.call(process);
}

export function processStartToken(pid: number): string {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    throw new ProcessObservationError(pid, error);
  }
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const token = fields[19];
  if (close < 1 || token === undefined || !/^\d+$/.test(token)) {
    throw new ProcessObservationError(pid);
  }
  return token;
}

/**
 * Who holds this inode open, and which of them can write to it.
 *
 * A process of this user whose descriptor table cannot be read is skipped. That is a real limit
 * and not a safe one on its own: the process nobody can inspect is exactly the one whose commits a
 * replacement would orphan. On a shared account there are always such processes, so refusing
 * whenever one exists would refuse always. What closes the gap is not this scan - it is the
 * barrier, which keeps cooperating processes from opening the file at all, and the exclusive
 * database lock the retention swap takes before it renames, which any SQLite writer must contend
 * with whether or not this scan can see it.
 */
export function discoverOpenInodeHolders(
  device: bigint,
  inode: bigint,
  required: readonly RegisteredAuthorityProcess[] = [],
): OpenInodeObservation {
  const holders: RegisteredAuthorityProcess[] = [];
  const writable: RegisteredAuthorityProcess[] = [];
  const unprovable: number[] = [];
  const requiredPids = new Set(required.map(item => item.pid));
  let fdCount = 0;
  // Dirent conversion may lstat UNKNOWN entries before this loop and race an exited PID.
  // Enumerate names only so every per-PID metadata read stays inside the classified try below.
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    try {
      // Every /proc read below can race a process that exits between the readdir above and the
      // inspection here. `ownedProcess` used to be called outside this try, so that race threw
      // straight out of this function instead of being classified below.
      if (!ownedProcess(pid)) continue;
      const startToken = processStartToken(pid);
      const process = { pid, start_token: startToken };
      const count = processOpenInodeCount(process, device, inode);
      if (count.descriptors === 0) continue;
      holders.push(process);
      if (count.writable !== 0) writable.push(process);
      fdCount += count.descriptors;
    } catch (error) {
      if (error instanceof ProcessObservationError) {
        // The process vanished mid-scan: that is absence, not a hole in the answer.
        if (gone(error)) continue;
        if (denied(error) && !requiredPids.has(pid)) {
          // Not skipped quietly: a process this cannot read is a hole in the answer, and the
          // caller that is about to replace a file has to be told rather than left to assume.
          unprovable.push(pid);
          continue;
        }
      }
      throw error;
    }
  }
  return { holders, writable_holders: writable, fd_count: fdCount, unprovable };
}

type OpenInodeCount = { readonly descriptors: number; readonly writable: number };

/**
 * Whether a descriptor can write, read from the same place the descriptor itself was read.
 *
 * `/proc/<pid>/fdinfo/<fd>` reports the open flags, whose low two bits are the access mode. A
 * descriptor whose mode cannot be read is counted as a writer: the question is asked to decide
 * whether replacing a file would silently discard somebody's commits, and an unanswered question
 * is not permission to do that.
 */
function descriptorWritable(pid: number, descriptor: string): boolean {
  let info: string;
  try {
    info = readFileSync(`/proc/${pid}/fdinfo/${descriptor}`, "utf8");
  } catch {
    return true;
  }
  const flags = /^flags:\s*(\d+)$/m.exec(info)?.[1];
  if (flags === undefined) return true;
  const mode = Number.parseInt(flags, 8) & 3;
  return mode !== 0;
}

function processOpenInodeCount(
  process: RegisteredAuthorityProcess,
  device: bigint,
  inode: bigint,
): OpenInodeCount {
  let descriptors: readonly string[];
  try {
    descriptors = readdirSync(`/proc/${process.pid}/fd`);
  } catch (error) {
    // Classified by the caller: a vanished process is absence, an unreadable one is a hole.
    throw new ProcessObservationError(process.pid, error);
  }
  let count = 0;
  let writable = 0;
  for (const descriptor of descriptors) {
    try {
      const metadata = statSync(`/proc/${process.pid}/fd/${descriptor}`, { bigint: true });
      if (metadata.dev !== device || metadata.ino !== inode) continue;
      count += 1;
      if (descriptorWritable(process.pid, descriptor)) writable += 1;
    } catch (error) {
      // This one descriptor closed mid-scan; the process and its other descriptors may still
      // be live, so this is skipped rather than failing the whole process observation.
      if (goneCode(error)) continue;
      throw new ProcessObservationError(process.pid, error);
    }
  }
  return { descriptors: count, writable };
}

function ownedProcess(pid: number): boolean {
  try {
    return statSync(`/proc/${pid}`).uid === effectiveUserId();
  } catch (error) {
    // Classified by the caller: a vanished process is absence, an unreadable one is a hole.
    throw new ProcessObservationError(pid, error);
  }
}

/**
 * Whether an fs error means the process/descriptor it names is simply gone - the ordinary result
 * of a race between enumerating /proc and inspecting one of its entries, not a failure to answer.
 * ESRCH cannot come from these filesystem calls today, but is included so every place in this file
 * that classifies a vanished process agrees with the ENOENT/ESRCH-is-absent rule used elsewhere for
 * PIDs that exited (see the test-runtime process helper), rather than drifting from it.
 */
function goneCode(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ESRCH";
}

/** Whether a `ProcessObservationError` was caused by the observed process having vanished. */
function gone(error: ProcessObservationError): boolean {
  return goneCode(error.cause);
}

/**
 * Whether a `ProcessObservationError` was caused by a permission failure - a process this user
 * owns but cannot read, which fails closed as `unprovable` rather than being skipped like an
 * absent one.
 */
function denied(error: ProcessObservationError): boolean {
  if (!(error.cause instanceof Error)) return false;
  const code = Reflect.get(error.cause, "code");
  return code === "EACCES" || code === "EPERM";
}

export class ProcessObservationError extends Error {
  readonly name = "ProcessObservationError";
  constructor(readonly pid: number, cause?: unknown) {
    super(`process observation failed: ${pid}`, cause === undefined ? undefined : { cause });
  }
}

/**
 * Why a writer outside this process's reach cannot be excluded from this database, or null when
 * it can. The scan answers for processes of this user; a file another user may write admits a
 * writer that never has to appear in that answer at all, and a replacement would discard whatever
 * it commits next. A privileged process can write regardless, which no user-space protocol
 * excludes - that is this contract's stated limit rather than an assumption hidden inside it.
 */
/**
 * The parts of a hole, for a caller that reports it rather than refusing on it.
 *
 * The refusal only needs to know there is a hole. An operator needs to know which one, and which
 * processes they would have to look at - so the one place that spells a hole also reads it back,
 * and the wording stays in a single file.
 */
export function parseExclusionHole(hole: string): {
  readonly reason: string; readonly unreadable_processes: readonly number[];
} {
  const prefix = "unreadable_processes:";
  if (!hole.startsWith(prefix)) return { reason: hole, unreadable_processes: [] };
  const pids = hole.slice(prefix.length).split(",")
    .map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0);
  return { reason: "unreadable_processes", unreadable_processes: pids };
}

export function exclusionHole(filename: string, observed: OpenInodeObservation): string | null {
  // A process this user owns but cannot read is a hole, not a silence: nothing about it says it is
  // not holding this database. Destructive replacement stays refused until the answer is complete.
  if (observed.unprovable.length !== 0) {
    return `unreadable_processes:${observed.unprovable.join(",")}`;
  }
  const source = statSync(filename);
  if (source.uid !== process.getuid?.()) return "owner_outside_this_user";
  if ((source.mode & 0o022) !== 0) return "writable_outside_this_user";
  return null;
}
