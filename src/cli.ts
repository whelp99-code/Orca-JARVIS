#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { JarvisError } from "./db.js";
import { execute } from "./cli-runtime.mjs";

export { execute } from "./cli-runtime.mjs";

function output(value: object): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
