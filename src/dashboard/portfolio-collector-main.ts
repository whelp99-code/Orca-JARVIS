import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { readPortfolioHmacKey } from "./portfolio-auth.js";
import {
  collectPortfolioEnvelope,
  type CollectorCommandRunner,
  type PortfolioCollectorInput,
} from "./portfolio-collector.js";
import type { PortfolioEnvironment } from "./portfolio-contracts.js";

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 1_000_000;
const DEFAULT_ORCA_BIN = "orca";
const DEFAULT_GH_BIN = "gh";
const DEFAULT_GIT_BIN = "git";

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      source: { type: "string" },
      "key-file": { type: "string" },
      "scope-file": { type: "string" },
      "status-file": { type: "string" },
      "orca-bin": { type: "string" },
      "gh-bin": { type: "string" },
      "git-bin": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (positionals.length !== 0) throw new Error("COLLECTOR_USAGE_INVALID");
  const source = parseSource(values.source);
  if (typeof values["key-file"] !== "string") throw new Error("COLLECTOR_USAGE_INVALID");
  const scopeFile = source === "local" ? requireFile(values["scope-file"]) : null;
  const statusFile = source === "local" ? requireFile(values["status-file"]) : null;
  const key = await readPortfolioHmacKey(values["key-file"]);
  const input: PortfolioCollectorInput = {
    source,
    scopeFile,
    statusFile,
    orcaRunner: commandRunner(values["orca-bin"] ?? DEFAULT_ORCA_BIN),
    ghRunner: commandRunner(values["gh-bin"] ?? DEFAULT_GH_BIN),
    gitRunner: commandRunner(values["git-bin"] ?? DEFAULT_GIT_BIN),
    readFile: (path) => readFile(path, "utf8"),
    clock: () => new Date(),
  };
  const envelope = await collectPortfolioEnvelope(input, key);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function commandRunner(bin: string): CollectorCommandRunner {
  return async (args) => {
    try {
      const { stdout } = await execFile(bin, args, {
        encoding: "utf8",
        maxBuffer: COMMAND_MAX_BUFFER,
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
      });
      return stdout;
    } catch {
      throw new Error("COLLECTOR_COMMAND_FAILED");
    }
  };
}

function parseSource(value: string | undefined): PortfolioEnvironment {
  if (value !== "local" && value !== "jm-server") throw new Error("COLLECTOR_USAGE_INVALID");
  return value;
}

function requireFile(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("COLLECTOR_USAGE_INVALID");
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.exitCode = 2;
  });
}
