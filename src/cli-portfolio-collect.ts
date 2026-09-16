import { JarvisError } from "./db.js";
import { readPortfolioHmacKey } from "./dashboard/portfolio-auth.js";
import { collectPortfolioEnvelope } from "./dashboard/portfolio-collector.js";
import { portfolioCollectorInput } from "./dashboard/portfolio-collector-input.js";
import { PORTFOLIO_ENVIRONMENTS, type PortfolioEnvironment } from "./dashboard/portfolio-contracts.js";
import { writePortfolioSpoolFile } from "./dashboard/portfolio-spool.js";

function requireSource(value: unknown): PortfolioEnvironment {
  if (typeof value !== "string" || !(PORTFOLIO_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new JarvisError("PORTFOLIO_SOURCE_INVALID");
  }
  return value as PortfolioEnvironment;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new JarvisError(code);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, "PORTFOLIO_SPOOL_INPUT_INVALID");
}

/**
 * `portfolio collect --spool DIR` - the collecting half of the spool-and-ingest split (cutover gap
 * G4). It reads the local host, signs the same envelope the piped collector always produced, and
 * writes it into a spool directory. It opens no database, and it is dispatched before the CLI
 * constructs one, so it keeps running as the interactive user who owns the Orca GUI session while
 * `jarvis.sqlite` belongs to the authority's service account. A `--db` on the command line is
 * accepted and ignored for exactly that reason: the collector unit may still carry one.
 */
export async function tryExecutePortfolioCollectCommand(input: {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown> | undefined> {
  const [command, subcommand] = input.positionals;
  if (command !== "portfolio" || subcommand !== "collect") return undefined;
  if (input.positionals.length !== 2) throw new JarvisError("PORTFOLIO_SPOOL_INPUT_INVALID");
  const { values } = input;
  const spool = requireString(values["spool"], "PORTFOLIO_SPOOL_INPUT_INVALID");
  if (!spool.startsWith("/")) throw new JarvisError("PORTFOLIO_SPOOL_INPUT_INVALID");
  const source = requireSource(values["source"]);
  const key = await readPortfolioHmacKey(requireString(values["key-file"], "PORTFOLIO_AUTH_REQUIRED"));
  // The LOCAL source is assembled from two operator-provided files; the JM-SERVER source is read
  // from the host itself. Requiring the pair only where it belongs keeps a misconfigured unit a
  // refusal rather than an envelope that silently reports nothing.
  const local = source === "local";
  const collected = portfolioCollectorInput({
    source,
    scopeFile: local ? requireString(values["scope-file"], "PORTFOLIO_SPOOL_INPUT_INVALID") : null,
    statusFile: local ? requireString(values["status-file"], "PORTFOLIO_SPOOL_INPUT_INVALID") : null,
    orcaBin: optionalString(values["orca-bin"]),
    ghBin: optionalString(values["gh-bin"]),
    gitBin: optionalString(values["git-bin"]),
  });
  const envelope = await collectPortfolioEnvelope(collected, key);
  const written = await writePortfolioSpoolFile(spool, Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"));
  return {
    ok: true,
    command: "portfolio.collect",
    source,
    spool,
    path: written.path,
    digest: `sha256:${written.digest}`,
  };
}
