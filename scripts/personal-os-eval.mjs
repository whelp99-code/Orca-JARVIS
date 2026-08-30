import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "test/fixtures/personal-os/full-loop.json" },
    json: { type: "boolean", default: false },
    requirePass: { type: "boolean", default: false },
  },
  strict: true,
});

try {
  const distIndex = join(process.cwd(), "dist/src/index.js");
  if (!existsSync(distIndex)) execFileSync("npm", ["run", "build:backend"], { stdio: "ignore" });
  const { evaluateLongitudinalDataset } = await import(pathToFileURL(distIndex).href);
  const dataset = JSON.parse(await readFile(values.fixture, "utf8"));
  const metrics = evaluateLongitudinalDataset(dataset);
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
  if (values.requirePass && !metrics.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "PERSONAL_OS_EVAL_FAILED"}\n`);
  process.exitCode = 1;
}
