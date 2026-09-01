#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "../dist/src/personal-os-systemd-verify.js");
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
const isolatedRoot = mkdtempSync(join("/dev/shm", "jarvis-task36-units-"));
try {
  const receipt = module.runNativeSystemdVerify({
    worktree: join(root, ".."),
    isolatedRoot,
  });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "systemd-analyze-production.log"), `${receipt.production_log}\nexit=${receipt.native_verify_exit}\ncommand=${receipt.production_command.join(" ")}\n`);
  writeFileSync(join(evidence, "systemd-analyze-fixture.log"), `${receipt.fixture_log}\nexit=${receipt.native_verify_exit}\ncommand=${receipt.fixture_command.join(" ")}\n`);
  writeFileSync(join(evidence, "systemd-verify.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.native_verify_exit === 0 ? 0 : 1;
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(isolatedRoot, { recursive: true, force: true });
}
