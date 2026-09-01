#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "../dist/src/personal-os-rehearsal.js");
if (!existsSync(dist)) {
  process.stderr.write("E_DIST_MISSING\n");
  process.exit(2);
}
const module = await import(pathToFileURL(dist).href);
try {
  await module.runPersonalOsRehearsalCli(process.argv.slice(2));
} catch (error) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "E_USAGE";
  process.stderr.write(`${code}\n`);
  process.exit(2);
}
