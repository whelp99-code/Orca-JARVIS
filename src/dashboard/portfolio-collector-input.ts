import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { CollectorCommandRunner, PortfolioCollectorInput } from "./portfolio-collector.js";
import type { PortfolioEnvironment } from "./portfolio-contracts.js";

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 1_000_000;
const DEFAULT_ORCA_BIN = "orca";
const DEFAULT_GH_BIN = "gh";
const DEFAULT_GIT_BIN = "git";

/**
 * The collector's host bindings, shared by the standalone collector entrypoint and by
 * `portfolio collect`. Collection reads the local host through these commands and opens no
 * database, which is what lets it keep running as the interactive user after the authority has
 * moved to a service account (cutover gap G4).
 */
export function collectorCommandRunner(bin: string): CollectorCommandRunner {
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

export function portfolioCollectorInput(input: {
  readonly source: PortfolioEnvironment;
  readonly scopeFile: string | null;
  readonly statusFile: string | null;
  readonly orcaBin?: string | undefined;
  readonly ghBin?: string | undefined;
  readonly gitBin?: string | undefined;
  readonly clock?: (() => Date) | undefined;
}): PortfolioCollectorInput {
  return {
    source: input.source,
    scopeFile: input.scopeFile,
    statusFile: input.statusFile,
    orcaRunner: collectorCommandRunner(input.orcaBin ?? DEFAULT_ORCA_BIN),
    ghRunner: collectorCommandRunner(input.ghBin ?? DEFAULT_GH_BIN),
    gitRunner: collectorCommandRunner(input.gitBin ?? DEFAULT_GIT_BIN),
    readFile: (path) => readFile(path, "utf8"),
    clock: input.clock ?? (() => new Date()),
  };
}
