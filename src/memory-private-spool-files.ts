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
  opendirSync,
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
  return readPrivateSpoolLinks(root, path, maximum, 1);
}

function readPrivateSpoolLinks(root: PrivateSpoolRoot, path: string, maximum: number, links: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_194_304) throw new Error("MEMORY_SPOOL_LIMIT_INVALID");
  assertPrivateSpoolRoot(root);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== links || (stat.mode & 0o077) !== 0
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
      || value.nlink !== links || value.mode !== stat.mode || value.uid !== stat.uid
      || value.mtimeMs !== stat.mtimeMs || value.ctimeMs !== stat.ctimeMs)) {
      throw new Error("MEMORY_SPOOL_FILE_CHANGED");
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

/** Recover only a dead publisher's exact final+temporary hardlink pair.
 * Unknown links and live/reused PIDs remain untouched. Ordinary readers require
 * one link; this bounded exception is used only by explicit publication retry. */
export function recoverPrivateSpoolPublication(root: PrivateSpoolRoot, path: string, expected: Buffer, prefix: string): boolean {
  assertPrivateSpoolRoot(root);
  const final = lstatSync(path);
  if (final.nlink === 1) return false;
  if (!/^[a-z][a-z-]{0,63}$/.test(prefix) || !final.isFile() || final.nlink !== 2) {
    throw new Error("MEMORY_SPOOL_FILE_INVALID");
  }
  const bytes = readPrivateSpoolLinks(root, path, expected.length, 2);
  if (!bytes.equals(expected)) throw new Error("MEMORY_SPOOL_RECOVERY_CONFLICT");
  const pattern = new RegExp(`^\\.${prefix}-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.tmp$`);
  const directory = opendirSync(root.path);
  let temporary: string | undefined;
  let pid: number | undefined;
  let count = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++count > 4096) throw new Error("MEMORY_SPOOL_RECOVERY_LIMIT");
      const match = pattern.exec(entry.name);
      if (!match) continue;
      const candidate = `${root.path}/${entry.name}`;
      const stat = lstatSync(candidate);
      if (stat.dev !== final.dev || stat.ino !== final.ino) continue;
      if (temporary !== undefined || !stat.isFile()) throw new Error("MEMORY_SPOOL_FILE_INVALID");
      temporary = candidate; pid = Number(match[1]);
    }
  } finally { directory.closeSync(); }
  if (temporary === undefined || pid === undefined || !Number.isSafeInteger(pid) || pid > 2_147_483_647) {
    throw new Error("MEMORY_SPOOL_RECOVERY_UNPROVED");
  }
  try { process.kill(pid, 0); throw new Error("MEMORY_SPOOL_PUBLISHER_ACTIVE"); }
  catch (error) { if (!isErrno(error, "ESRCH")) throw error; }
  // Recheck both names and contents before unlinking only the recognized temp.
  const retry = readPrivateSpoolLinks(root, path, expected.length, 2);
  const named = lstatSync(temporary);
  const current = lstatSync(path);
  assertPrivateSpoolRoot(root);
  if (!retry.equals(expected) || !named.isFile() || named.nlink !== 2
    || named.dev !== final.dev || named.ino !== final.ino
    || current.dev !== final.dev || current.ino !== final.ino) throw new Error("MEMORY_SPOOL_FILE_CHANGED");
  rmSync(temporary);
  syncPrivateSpoolDirectory(root);
  if (!readPrivateSpoolFile(root, path, expected.length).equals(expected)) throw new Error("MEMORY_SPOOL_FILE_CHANGED");
  return true;
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
