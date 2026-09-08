import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const BUILD_ROOTS = ["src", "tests", "migrations", "contracts"] as const;
export const BUILD_MAX_FILES = 16_384;
export const BUILD_MAX_BYTES = 256 * 1024 * 1024;
export const buildHash = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const fileVectorHash = (entries: readonly unknown[]): string =>
  buildHash(`orca-jarvis/backend-file-vector/v1\0${JSON.stringify(entries)}`);
export const migrationVectorHash = (entries: readonly unknown[]): string =>
  buildHash(`orca-jarvis/migration-vector/v1\0${JSON.stringify(entries)}`);

export type BuildFile = { readonly path: string; readonly bytes: number; readonly mode: number; readonly sha256: string };

export function observeBackendFiles(root: string): { readonly digest: string; readonly count: number } {
  const entries: BuildFile[] = [];
  let total = 0;
  function walk(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("BUILD_FILE_UNREADABLE");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) if (name !== "node_modules" && name !== ".git") walk(join(path, name));
      return;
    }
    if (!stat.isFile() || entries.length >= BUILD_MAX_FILES || stat.size > BUILD_MAX_BYTES - total) {
      throw new Error("BUILD_FILE_LIMIT");
    }
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total > BUILD_MAX_BYTES) throw new Error("BUILD_FILE_LIMIT");
    entries.push({ path: relative(root, path).split("\\").join("/"), bytes: bytes.length,
      mode: stat.mode & 0o777, sha256: buildHash(bytes) });
  }
  for (const name of BUILD_ROOTS) {
    const path = join(root, name);
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    walk(path);
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { digest: fileVectorHash(entries), count: entries.length };
}
