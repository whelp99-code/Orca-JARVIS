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
  const requiredPids = new Set(required.map(item => item.pid));
  let fdCount = 0;
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid < 1 || !ownedProcess(pid)) continue;
    let startToken: string;
    try {
      startToken = processStartToken(pid);
    } catch (error) {
      if (error instanceof ProcessObservationError && !processExists(pid)) continue;
      throw error;
    }
    const process = { pid, start_token: startToken };
    let count: OpenInodeCount;
    try {
      count = processOpenInodeCount(process, device, inode);
    } catch (error) {
      if (error instanceof ProcessObservationError && denied(error)
        && !requiredPids.has(pid)) continue;
      throw error;
    }
    if (count.descriptors === 0) continue;
    holders.push(process);
    if (count.writable !== 0) writable.push(process);
    fdCount += count.descriptors;
  }
  return { holders, writable_holders: writable, fd_count: fdCount };
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
    if (missing(error) && !processExists(process.pid)) return { descriptors: 0, writable: 0 };
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
      if (missing(error)) continue;
      throw new ProcessObservationError(process.pid, error);
    }
  }
  return { descriptors: count, writable };
}

function ownedProcess(pid: number): boolean {
  try {
    return statSync(`/proc/${pid}`).uid === effectiveUserId();
  } catch (error) {
    if (missing(error)) return false;
    throw new ProcessObservationError(pid, error);
  }
}

function processExists(pid: number): boolean {
  try {
    statSync(`/proc/${pid}`);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw new ProcessObservationError(pid, error);
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

function denied(error: ProcessObservationError): boolean {
  return error.cause instanceof Error && Reflect.get(error.cause, "code") === "EACCES";
}

export class ProcessObservationError extends Error {
  readonly name = "ProcessObservationError";
  constructor(readonly pid: number, cause?: unknown) {
    super(`process observation failed: ${pid}`, cause === undefined ? undefined : { cause });
  }
}
