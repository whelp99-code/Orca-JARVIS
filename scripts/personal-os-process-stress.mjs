#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "../dist/src/personal-os-process-stress.js");
if (!existsSync(dist)) {
  process.stderr.write("E_DIST_MISSING\n");
  process.exit(2);
}
const evidence = process.argv[2];
if (evidence === undefined || evidence.length === 0) {
  process.stderr.write("E_USAGE\n");
  process.exit(2);
}
const module = await import(pathToFileURL(dist).href);
const isolatedRoot = mkdtempSync(join("/dev/shm", "jarvis-task36-stress-"));
try {
  const receipt = await module.runPersonalOsProcessStress({
    isolatedRoot,
    worktree: join(root, ".."),
    cycleCount: 10_000,
    crashAfterDispatchId: 5_000,
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "process-stress.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.cycles_completed === 10_000 && receipt.runtime_surface === "staged-execstart" ? 0 : 1;
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(isolatedRoot, { recursive: true, force: true });
}
