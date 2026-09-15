import { createPrivateKey, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

export const MEMORY_SIGNING_KEY_MAX_BYTES = 16_384;

/**
 * Read one Ed25519 private key a deployment provisioned on disk.
 *
 * Existing configuration only: this never generates, rotates or registers a key. The file must be a
 * single-link regular file the current user owns, with no group or other permission bits, small
 * enough to be a key rather than a payload. Returns undefined for every failure so each caller can
 * name its own error code instead of leaking a filesystem reason.
 */
export function readEd25519PrivateKeyFile(path: string): KeyObject | undefined {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  let fd: number | undefined;
  const bytes = Buffer.alloc(MEMORY_SIGNING_KEY_MAX_BYTES + 1);
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (process.getuid !== undefined && stat.uid !== process.getuid())
        || stat.size < 1 || stat.size > MEMORY_SIGNING_KEY_MAX_BYTES) return undefined;
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      if (length !== stat.size) return undefined;
      const key = createPrivateKey(bytes.subarray(0, length));
      return key.asymmetricKeyType === "ed25519" ? key : undefined;
    } finally { bytes.fill(0); if (fd !== undefined) closeSync(fd); }
  } catch { return undefined; }
}
