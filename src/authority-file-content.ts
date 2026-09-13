import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";

/** Bounded-memory content evidence; refuse a changed or replaced file during its scan. */
export function authorityFileContent(path: string, expected: BigIntStats): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const same = (actual: BigIntStats) => actual.isFile() && actual.dev === expected.dev
    && actual.ino === expected.ino && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs;
  try {
    if (!same(fstatSync(fd, { bigint: true })) || expected.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("AUTHORITY_FILE_CHANGED_DURING_READ");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = Number(expected.size);
    for (let offset = 0; offset < size;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) throw new Error("AUTHORITY_FILE_CHANGED_DURING_READ");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (!same(fstatSync(fd, { bigint: true }))) throw new Error("AUTHORITY_FILE_CHANGED_DURING_READ");
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
