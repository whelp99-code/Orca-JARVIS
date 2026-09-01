import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTask32QaServer, type Task32QaScenario } from "./task32-memory-qa-server.js";

const SCENARIOS = ["schema4", "conflicts", "no-data", "offline", "schema3",
  "pending-approval", "applying", "complete", "forgotten-removal"] as const;

function isScenario(value: string | undefined): value is Task32QaScenario {
  return SCENARIOS.some(scenario => scenario === value);
}

function scenarioArgument(args: readonly string[]): Task32QaScenario {
  const index = args.indexOf("--scenario");
  const value = index >= 0 ? args[index + 1] : "happy";
  if (!isScenario(value)) throw new TypeError(`TASK32_QA_SCENARIO_INVALID:${String(value)}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readyIndex = args.indexOf("--ready-file");
  const server = await startTask32QaServer(scenarioArgument(args));
  const ready = { url: server.url, root: server.root, pid: process.pid };
  const readyFile = readyIndex >= 0 ? args[readyIndex + 1] : undefined;
  if (readyFile !== undefined) writeFileSync(readyFile, `${JSON.stringify(ready)}\n`);
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  const shutdown = (): void => { void server.close().then(() => { process.exit(0); }); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === entry) await main();
