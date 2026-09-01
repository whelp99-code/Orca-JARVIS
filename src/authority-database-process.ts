import { readdirSync, readFileSync, statSync } from "node:fs";

export type RegisteredAuthorityProcess = {
  readonly pid: number;
  readonly start_token: string;
};

export type OpenInodeObservation = {
  readonly holders: readonly RegisteredAuthorityProcess[];
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

export function discoverOpenInodeHolders(
  device: bigint,
  inode: bigint,
  required: readonly RegisteredAuthorityProcess[] = [],
): OpenInodeObservation {
  const holders: RegisteredAuthorityProcess[] = [];
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
    let count: number;
    try {
      count = processOpenInodeCount(process, device, inode);
    } catch (error) {
      if (error instanceof ProcessObservationError && denied(error)
        && !requiredPids.has(pid)) continue;
      throw error;
    }
    if (count === 0) continue;
    holders.push(process);
    fdCount += count;
  }
  return { holders, fd_count: fdCount };
}

function processOpenInodeCount(
  process: RegisteredAuthorityProcess,
  device: bigint,
  inode: bigint,
): number {
  let descriptors: readonly string[];
  try {
    descriptors = readdirSync(`/proc/${process.pid}/fd`);
  } catch (error) {
    if (missing(error) && !processExists(process.pid)) return 0;
    throw new ProcessObservationError(process.pid, error);
  }
  let count = 0;
  for (const descriptor of descriptors) {
    try {
      const metadata = statSync(`/proc/${process.pid}/fd/${descriptor}`, { bigint: true });
      if (metadata.dev === device && metadata.ino === inode) count += 1;
    } catch (error) {
      if (missing(error)) continue;
      throw new ProcessObservationError(process.pid, error);
    }
  }
  return count;
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
