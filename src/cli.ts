#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JarvisError } from "./db.js";
import { execute } from "./cli-runtime.mjs";

export { execute } from "./cli-runtime.mjs";

function output(value: object): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`);
  // A command that reports a gate verdict opts into a non-zero exit by returning exit_code, so the
  // caller can branch on process status without parsing the report the command still printed.
  const requested = Reflect.get(value, "exit_code");
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0) {
    process.exitCode = requested;
  }
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
