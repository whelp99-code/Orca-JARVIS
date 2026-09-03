#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JarvisError } from "./db.js";
import { execute } from "./cli-runtime.mjs";

export { execute } from "./cli-runtime.mjs";

function output(value: object): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

if (isDirectRun()) {
  execute(process.argv.slice(2))
    .then(output)
    .catch((error: unknown) => {
      const result = error instanceof JarvisError
        ? error
        : new JarvisError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown");
      process.stderr.write(`${JSON.stringify({
        version: 1,
        ok: false,
        error: { code: result.code, message: result.message },
      })}\n`);
      process.exitCode = 2;
    });
}
