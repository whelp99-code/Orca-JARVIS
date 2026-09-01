import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function personalOsScratch(prefix = "jarvis-task36-"): string {
  const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function removeScratch(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
