import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JarvisError } from "./db.js";
import type { MemoryRuntimeLayout } from "./memory-managed-surface-scanner.js";
import { withMemoryContentRepresentations } from "./memory-content-representations.js";

export function disposeSensitiveManagedCopies(
  layout: MemoryRuntimeLayout,
  sensitive: readonly Buffer[],
): number {
  return withMemoryContentRepresentations(sensitive, representations => {
    let disposed = 0;
    for (const root of [layout.spool_root, layout.state_root, layout.backup_root, layout.restore_root]) {
      disposed += disposeRoot(root, representations);
    }
    if (countRootMatches(layout.dist_root, representations) !== 0) {
      throw new JarvisError("MEMORY_DIST_RUNTIME_FIXTURE_MATCH");
    }
    return disposed;
  });
}

export function countManagedMatches(
  layout: MemoryRuntimeLayout,
  sensitive: readonly Buffer[],
): number {
  return withMemoryContentRepresentations(sensitive, representations => [layout.spool_root, layout.state_root, layout.dist_root,
    layout.backup_root, layout.restore_root]
    .reduce((total, root) => total + countRootMatches(root, representations), 0));
}

function disposeRoot(root: string, sensitive: readonly Buffer[]): number {
  if (!existsSync(root)) throw new JarvisError("MEMORY_MANAGED_ROOT_MISSING");
  let disposed = 0;
  const visit = (path: string): boolean => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory()
      && (!metadata.isFile() || metadata.nlink !== 1))) {
      throw new JarvisError("MEMORY_MANAGED_ROOT_UNSAFE");
    }
    if (metadata.isFile()) {
      const matches = contains(readFileSync(path), sensitive);
      if (matches) { rmSync(path, { force: true }); disposed += 1; }
      return matches;
    }
    for (const name of readdirSync(path).sort()) visit(join(path, name));
    return false;
  };
  visit(root);
  return disposed;
}

function countRootMatches(root: string, sensitive: readonly Buffer[]): number {
  if (!existsSync(root)) throw new JarvisError("MEMORY_MANAGED_ROOT_MISSING");
  let matches = 0;
  const visit = (path: string): void => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory()
      && (!metadata.isFile() || metadata.nlink !== 1))) {
      throw new JarvisError("MEMORY_MANAGED_ROOT_UNSAFE");
    }
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (contains(readFileSync(path), sensitive)) matches += 1;
  };
  visit(root);
  return matches;
}

function contains(value: Buffer, sensitive: readonly Buffer[]): boolean {
  return sensitive.some(item => item.byteLength > 0 && value.includes(item));
}
