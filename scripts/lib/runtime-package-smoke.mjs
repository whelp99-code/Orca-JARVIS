import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Only the newly created sibling scratch directory is removed, including on smoke failure. */
export function withRuntimePackageSmoke(output, run, environment = process.env) {
  const scratch = mkdtempSync(join(dirname(output), "jarvis-runtime-smoke-"));
  try {
    return run({ ...environment, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Inspect filenames only: test database, key and session contents must never be decoded. */
export function assertRuntimePackageNoTestState(output) {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === "smoke-state" || entry.name === "gjc.json"
        || /\.sqlite(?:-wal|-shm|-journal)?$/.test(entry.name) || entry.name.endsWith(".pem")) {
        throw new Error(`RUNTIME_PACKAGE_TEST_STATE_PRESENT ${relative(output, path)}`);
      }
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(output);
}
