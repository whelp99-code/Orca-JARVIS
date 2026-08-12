import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JarvisError } from "./db.js";

export interface SecureRoot {
  path: string;
  device: number;
  inode: number;
}

const currentUid = (): number | undefined => typeof process.getuid === "function" ? process.getuid() : undefined;

const assertOwnedDirectory = (value: Stats): void => {
  if (!value.isDirectory() || value.isSymbolicLink()) throw new JarvisError("APPROVED_PATH_SYMLINK");
  const uid = currentUid();
  if (uid !== undefined && value.uid !== uid) throw new JarvisError("APPROVED_PATH_OWNER");
};

export async function secureRoot(path: string): Promise<SecureRoot> {
  const absolute = resolve(path);
  try {
    assertOwnedDirectory(await lstat(absolute));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(absolute, { mode: 0o700 });
  }
  await chmod(absolute, 0o700);
  const value = await lstat(absolute);
  assertOwnedDirectory(value);
  return { path: absolute, device: value.dev, inode: value.ino };
}

export function secureBasename(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new JarvisError("APPROVED_PATH_INVALID");
  }
  return value;
}

export async function assertRootIdentity(root: SecureRoot): Promise<void> {
  const value = await lstat(root.path);
  assertOwnedDirectory(value);
  if (value.dev !== root.device || value.ino !== root.inode) throw new JarvisError("APPROVED_PATH_CHANGED");
}

export function privatePath(root: SecureRoot, label: string): string {
  return join(root.path, `.${label}.${randomUUID()}`);
}

export async function syncFile(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await file.stat();
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw new JarvisError("APPROVED_PATH_INVALID");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function publishFile(root: SecureRoot, temporary: string, basename: string): Promise<string> {
  await syncFile(temporary);
  await assertRootIdentity(root);
  const destination = join(root.path, secureBasename(basename));
  await rename(temporary, destination);
  await syncDirectory(root.path);
  return destination;
}

export async function copyPinnedRegularFile(root: SecureRoot, basename: unknown, label: string): Promise<string> {
  const sourcePath = join(root.path, secureBasename(basename));
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new JarvisError("APPROVED_PATH_SYMLINK");
    throw error;
  });
  const copyPath = privatePath(root, label);
  const copy = await open(copyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new JarvisError("APPROVED_PATH_SYMLINK");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await copy.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    await copy.sync();
    await assertRootIdentity(root);
    return copyPath;
  } catch (error) {
    await rm(copyPath, { force: true });
    throw error;
  } finally {
    await source.close();
    await copy.close();
  }
}

export async function removeSqliteCopy(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map(candidate => rm(candidate, { force: true })));
}
