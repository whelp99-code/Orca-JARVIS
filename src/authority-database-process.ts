import { readFileSync, readdirSync, statSync } from "node:fs";

export type RegisteredAuthorityProcess = {
  readonly pid: number;
  readonly start_token: string;
};

export function processStartToken(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const token = fields[19];
  if (close < 1 || token === undefined || !/^\d+$/.test(token)) {
    throw new ProcessObservationError(pid);
  }
  return token;
}

export function countOpenInode(
  processes: readonly RegisteredAuthorityProcess[],
  device: bigint,
  inode: bigint,
): number {
  let count = 0;
  for (const process of processes) {
    if (processStartToken(process.pid) !== process.start_token) continue;
    let descriptors: readonly string[];
    try {
      descriptors = readdirSync(`/proc/${process.pid}/fd`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const metadata = statSync(`/proc/${process.pid}/fd/${descriptor}`, { bigint: true });
        if (metadata.dev === device && metadata.ino === inode) count += 1;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
  }
  return count;
}

export class ProcessObservationError extends Error {
  readonly name = "ProcessObservationError";
  constructor(readonly pid: number) {
    super(`process observation failed: ${pid}`);
  }
}
