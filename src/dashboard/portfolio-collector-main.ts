import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readPortfolioHmacKey } from "./portfolio-auth.js";
import { collectPortfolioEnvelope } from "./portfolio-collector.js";
import { portfolioCollectorInput } from "./portfolio-collector-input.js";
import type { PortfolioEnvironment } from "./portfolio-contracts.js";
import { writePortfolioSpoolFile } from "./portfolio-spool.js";

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
      spool: { type: "string" },
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
  const input = portfolioCollectorInput({
    source,
    scopeFile,
    statusFile,
    orcaBin: values["orca-bin"],
    ghBin: values["gh-bin"],
    gitBin: values["git-bin"],
  });
  const envelope = await collectPortfolioEnvelope(input, key);
  const bytes = `${JSON.stringify(envelope)}\n`;
  // With `--spool` the envelope is handed over through the filesystem instead of a pipe, so the
  // process that ingests it - and opens the authority database - need not be this one's child
  // (cutover gap G4). Without it the entrypoint behaves exactly as it always did.
  if (typeof values.spool === "string") {
    if (values.spool.length === 0 || !values.spool.startsWith("/")) throw new Error("COLLECTOR_USAGE_INVALID");
    await writePortfolioSpoolFile(values.spool, Buffer.from(bytes, "utf8"));
    return;
  }
  process.stdout.write(bytes);
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
