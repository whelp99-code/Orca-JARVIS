// Test-only child-process entry for the compiled CLI, executed as dist/tests/fixtures/*.js so
// every module it reaches is the same compiled build the product binary uses.
//
// The product binary takes its clock from the process and exposes no override, and it must not
// gain one: a fixed-instant flag on a shipped binary is an operational bypass, not test support.
// This entry injects the clock the way the runtime already supports it, through execute()'s
// dependencies, and mirrors the direct-run wrapper in src/cli.ts - a versioned JSON envelope on
// stdout for success, the same envelope on stderr with exit code 2 for a failure.
import { execute } from "../../src/cli.js";
import { JarvisError } from "../../src/db.js";

const [dbPath, inputPath, clockIso, ...rest] = process.argv.slice(2);
const at = new Date(String(clockIso));
if (dbPath === undefined || inputPath === undefined || Number.isNaN(at.getTime())) {
  process.stderr.write("usage: compiled-daily-cli <db> <input> <clock-iso> [args...]\n");
  process.exit(64);
}

try {
  const result = await execute(
    ["daily", "morning", "--once", "--db", dbPath, "--input", inputPath, ...rest],
    { clock: () => at },
  );
  process.stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
} catch (error) {
  const failure = error instanceof JarvisError
    ? error
    : new JarvisError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown");
  process.stderr.write(`${JSON.stringify({
    version: 1, ok: false, error: { code: failure.code, message: failure.message },
  })}\n`);
  process.exitCode = 2;
}
