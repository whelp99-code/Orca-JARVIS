import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export function privateRunRoot(env = globalThis.process.env) {
  const root = env.TMPDIR;
  if (typeof root !== "string" || basename(root).startsWith("run-") === false) return undefined;
  return root;
}

export function removeNewProviderChildren(root, seen) {
  const removed = [];
  for (const name of readdirSync(root)) {
    if (seen.has(name)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
