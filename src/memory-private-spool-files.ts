import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";

const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;

export type PrivateSpoolIdentity = { readonly dev: number; readonly ino: number };
export type PrivateSpoolRoot = { readonly path: string; readonly identity: PrivateSpoolIdentity };

export function openPrivateSpoolRoot(path: string): PrivateSpoolRoot {
  mkdirSync(path, { recursive: true, mode: ROOT_MODE });
  chmodSync(path, ROOT_MODE);
  return inspectPrivateSpoolRoot(path);
}

/** Bind an existing private directory without creating it or repairing its permissions. */
export function inspectPrivateSpoolRoot(path: string): PrivateSpoolRoot {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || !ownedByCurrentUser(stat.uid)) {
    throw new Error("MEMORY_SPOOL_ROOT_INVALID");
  }
  return { path, identity: { dev: stat.dev, ino: stat.ino } };
}

export function assertPrivateSpoolRoot(root: PrivateSpoolRoot): void {
  const stat = lstatSync(root.path);
  if (!stat.isDirectory() || stat.dev !== root.identity.dev || stat.ino !== root.identity.ino
    || (stat.mode & 0o077) !== 0 || !ownedByCurrentUser(stat.uid)) {
    throw new Error("MEMORY_SPOOL_ROOT_CHANGED");
  }
}

export function writePrivateSpoolFile(root: PrivateSpoolRoot, path: string, bytes: Buffer, prefix: string): boolean {
  assertPrivateSpoolRoot(root);
  const temporary = `${root.path}/.${prefix}-${process.pid}-${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== bytes.byteLength || (stat.mode & 0o077) !== 0
      || !ownedByCurrentUser(stat.uid)) throw new Error("MEMORY_SPOOL_FILE_INVALID");
    closeSync(descriptor);
    descriptor = undefined;
    assertPrivateSpoolRoot(root);
    try {
      linkSync(temporary, path);
      syncPrivateSpoolDirectory(root);
      return true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      return false;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function readPrivateSpoolFile(root: PrivateSpoolRoot, path: string, maximum = 4_194_304): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_194_304) throw new Error("MEMORY_SPOOL_LIMIT_INVALID");
  assertPrivateSpoolRoot(root);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || !ownedByCurrentUser(stat.uid) || stat.size > maximum) throw new Error("MEMORY_SPOOL_FILE_INVALID");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    const named = lstatSync(path);
    assertPrivateSpoolRoot(root);
    if (offset !== stat.size || [after, named].some(value => !value.isFile()
      || value.dev !== stat.dev || value.ino !== stat.ino || value.size !== stat.size
      || value.nlink !== 1 || value.mode !== stat.mode || value.uid !== stat.uid
      || value.mtimeMs !== stat.mtimeMs || value.ctimeMs !== stat.ctimeMs)) {
      throw new Error("MEMORY_SPOOL_FILE_CHANGED");
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

export function removePrivateSpoolFile(root: PrivateSpoolRoot, path: string): void {
  assertPrivateSpoolRoot(root);
  rmSync(path);
  syncPrivateSpoolDirectory(root);
}

export function syncPrivateSpoolDirectory(root: PrivateSpoolRoot): void {
  assertPrivateSpoolRoot(root);
  const descriptor = openSync(root.path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && Reflect.get(error, "code") === code;
}
