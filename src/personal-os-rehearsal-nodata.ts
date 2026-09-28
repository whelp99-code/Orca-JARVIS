import { spawnSync } from "node:child_process";
import { PersonalOsError } from "./personal-os-errors.js";
import { createSecondBrainTransport, SecondBrainTransportError } from "./second-brain-transport.js";
import type { ProviderInstall } from "./personal-os-rehearsal-provider.js";

export type NoDataObservation = {
  readonly booted: boolean;
  readonly data_state: "no_data" | "ready" | "unavailable";
  readonly page_count: number;
  readonly search_kind: string | null;
  readonly search_hits: number | null;
};

function pageCount(python: string, vaultRoot: string): number {
  const result = spawnSync(python, ["-c", PAGE_COUNT, vaultRoot], { encoding: "utf8" });
  if (result.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== "object" || parsed === null || !("page_count" in parsed)) {
    throw new PersonalOsError("E_REHEARSAL_GATE");
  }
  const count = Reflect.get(parsed, "page_count");
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  return count;
}

function bootPackagedRuntime(cliPath: string, launcher: string, configPath: string): boolean {
  const result = spawnSync(process.execPath, [cliPath, "second-brain", "readiness", "--json"], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      JARVIS_SECOND_BRAIN_LAUNCHER: launcher,
      JARVIS_SECOND_BRAIN_CONFIG: configPath,
    },
  });
  return result.status === 0 && result.stdout.includes("\"second_brain\"");
}

export async function observeNoDataBoot(input: {
  readonly cliPath?: string;
  readonly install: ProviderInstall;
  readonly vaultRoot?: string;
}): Promise<NoDataObservation> {
  const vaultRoot = input.vaultRoot ?? input.install.vaultRoot;
  const booted = input.cliPath === undefined
    ? false
    : bootPackagedRuntime(input.cliPath, input.install.launcher, input.install.configPath);
  const pages = pageCount(`${input.install.venv}/bin/python`, vaultRoot);
  const transport = createSecondBrainTransport({
    launcherPath: input.install.launcher,
    configPath: input.install.configPath,
    safeReadRetries: 0,
  });
  let searchKind: string | null = null;
  let searchHits: number | null = null;
  try {
    await transport.restart();
    const outcome = await transport.call("sb_search", { query: "NOT-EMPTY-VAULT", limit: 5 });
    searchKind = outcome.kind;
    if (outcome.kind === "data") {
      const results = outcome.value["results"];
      searchHits = Array.isArray(results) ? results.length : null;
    } else if (outcome.kind === "no_data") {
      searchHits = 0;
    }
  } catch (error) {
    if (!(error instanceof SecondBrainTransportError)) throw error;
    searchKind = error.code;
  } finally {
    await transport.close();
  }
  const emptySearch = searchKind === "no_data" || (searchKind === "data" && searchHits === 0);
  const data_state = pages > 0 || (searchHits !== null && searchHits > 0)
    ? "ready"
    : emptySearch && pages === 0
      ? "no_data"
      : "unavailable";
  return { booted, data_state, page_count: pages, search_kind: searchKind, search_hits: searchHits };
}

const PAGE_COUNT = `
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
pages = []
if root.is_dir():
    for path in root.rglob("*.md"):
        if ".git" in path.parts or path.name == "log.md":
            continue
        pages.append(path.name)
print(json.dumps({"page_count": len(pages)}))
`;
