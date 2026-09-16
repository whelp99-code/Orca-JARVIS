import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import {
  PORTFOLIO_SPOOL_SUFFIX,
  portfolioSpoolDigest,
} from "../../src/dashboard/portfolio-spool.js";
import { jmReport, PORTFOLIO_AT } from "../fixtures/portfolio-report.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

async function migrated(): Promise<string> {
  const path = tempDb();
  (await migratedTestDatabase(path)).close();
  return path;
}

function keyFile(): { readonly key: Buffer; readonly path: string } {
  const path = join(temporaryDirectory("jarvis-portfolio-key-"), "jm-server.key");
  const key = Buffer.alloc(32, 0x5a);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { key, path };
}

/** One spool file, written exactly as `portfolio collect` writes it. */
function spooled(directory: string, key: Buffer, reportedAt = PORTFOLIO_AT): string {
  const envelope = signPortfolioEnvelope(jmReport({ reported_at: reportedAt }), key);
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  const name = `${portfolioSpoolDigest(bytes)}${PORTFOLIO_SPOOL_SUFFIX}`;
  writeFileSync(join(directory, name), bytes, { mode: 0o640 });
  return name;
}

const clock = () => new Date(PORTFOLIO_AT);
const spoolNames = (directory: string) =>
  readdirSync(directory).filter(name => name.endsWith(PORTFOLIO_SPOOL_SUFFIX));

/**
 * Gap G4 of the jarvis-svc cutover: `portfolio ingest` could only be fed by a process that opened
 * the authority database, so the collector - which has to run as the interactive user who owns the
 * Orca GUI session it reads - was also a `jm`-owned holder of `jarvis.sqlite`. That is exactly what
 * makes `retention-preflight` report `owner_outside_this_user`, and the collector was retired for
 * it. The spool splits the two halves apart.
 */
describe("portfolio spool-and-ingest split", () => {
  it("collects into the spool without opening a database", async () => {
    // Given
    const spool = join(temporaryDirectory("jarvis-spool-"), "portfolio");
    const auth = keyFile();

    // When
    // A database that could not possibly be opened: the parent directory does not exist. The
    // collector must not care, because it is answered before the CLI constructs one.
    const result = await execute([
      "portfolio", "collect", "--spool", spool, "--source", "jm-server",
      "--key-file", auth.path, "--db", "/nonexistent/jarvis-svc/jarvis.sqlite",
      "--orca-bin", "/bin/false", "--git-bin", "/bin/false",
    ], { clock });

    // Then
    expect(result).toMatchObject({ ok: true, command: "portfolio.collect", source: "jm-server", spool });
    expect(existsSync("/nonexistent/jarvis-svc/jarvis.sqlite")).toBe(false);
    // The collector's own failure is still a signed envelope, so the authority learns the collector
    // is broken instead of the projection silently going stale.
    const names = spoolNames(spool);
    expect(names).toHaveLength(1);
    expect(String(Reflect.get(result, "path"))).toBe(join(spool, names[0]!));
    expect(String(Reflect.get(result, "digest"))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("consumes each spool file exactly once and ignores a duplicate", async () => {
    // Given
    const dbPath = await migrated();
    const spool = temporaryDirectory("jarvis-spool-");
    const auth = keyFile();
    const name = spooled(spool, auth.key);
    const ingest = () => execute([
      "portfolio", "ingest", "--spool", spool, "--source", "jm-server",
      "--key-file", auth.path, "--db", dbPath,
    ], { clock });

    // When
    const first = await ingest();
    const second = await ingest();
    // The collector ran again and produced the identical envelope, so the identical file reappears.
    spooled(spool, auth.key);
    const third = await ingest();

    // Then
    expect(first).toMatchObject({ ok: true, command: "portfolio.ingest", ingested: 1, duplicates: 0, refused: [] });
    // The ledger is the processed directory, keyed by the envelope's digest.
    expect(existsSync(join(spool, "processed", name))).toBe(true);
    expect(spoolNames(spool)).toEqual([]);
    // Nothing left to consume, and nothing invented.
    expect(second).toMatchObject({ ingested: 0, duplicates: 0, refused: [] });
    // A re-collected duplicate is dropped on the digest, never re-applied to the projection.
    expect(third).toMatchObject({ ingested: 0, duplicates: 1, refused: [] });
    expect(spoolNames(spool)).toEqual([]);
    const db = new AuthorityDb(dbPath);
    const row = db.db.prepare(
      "SELECT environment,producer,collector_status,last_reported_at FROM dashboard_portfolio_projection",
    ).all();
    db.close();
    expect(row).toEqual([{
      environment: "jm-server", producer: "jarvis-jm-server",
      collector_status: "ok", last_reported_at: PORTFOLIO_AT,
    }]);
  });

  it("refuses a malformed or mis-signed spool file, quarantines it and keeps the batch running", async () => {
    // Given
    const dbPath = await migrated();
    const spool = temporaryDirectory("jarvis-spool-");
    const auth = keyFile();
    const good = spooled(spool, auth.key);
    const truncated = `${"0".repeat(64)}${PORTFOLIO_SPOOL_SUFFIX}`;
    writeFileSync(join(spool, truncated), "{not json", { mode: 0o640 });
    // Correctly shaped, signed under a key this authority does not hold.
    const forgedEnvelope = signPortfolioEnvelope(jmReport(), Buffer.alloc(32, 0x11));
    const forged = `${"1".repeat(64)}${PORTFOLIO_SPOOL_SUFFIX}`;
    writeFileSync(join(spool, forged), `${JSON.stringify(forgedEnvelope)}\n`, { mode: 0o640 });

    // When
    const result = await execute([
      "portfolio", "ingest", "--spool", spool, "--source", "jm-server",
      "--key-file", auth.path, "--db", dbPath,
    ], { clock });

    // Then
    // The good envelope still landed: one bad file does not stop the lane.
    expect(result).toMatchObject({ ok: true, ingested: 1, duplicates: 0 });
    expect(existsSync(join(spool, "processed", good))).toBe(true);
    // Both refusals are reported by name and code, and quarantined rather than retried in silence.
    expect(Reflect.get(result, "refused")).toEqual([
      { file: truncated, code: "PORTFOLIO_INPUT_INVALID" },
      { file: forged, code: "PORTFOLIO_AUTH_INVALID" },
    ]);
    expect(existsSync(join(spool, "refused", truncated))).toBe(true);
    expect(existsSync(join(spool, "refused", forged))).toBe(true);
    expect(spoolNames(spool)).toEqual([]);
  });

  it("refuses a relative spool path and the collector flags on an unrelated command", async () => {
    // Given
    const auth = keyFile();

    // When / Then
    // These paths are written into units and compared, never resolved against a working directory.
    await expect(execute(["portfolio", "collect", "--spool", "spool", "--source", "jm-server",
      "--key-file", auth.path])).rejects.toThrow("PORTFOLIO_SPOOL_INPUT_INVALID");
    await expect(execute(["portfolio", "collect", "--source", "jm-server", "--key-file", auth.path]))
      .rejects.toThrow("PORTFOLIO_SPOOL_INPUT_INVALID");
    // The collector's flags belong to the portfolio commands and to nothing else.
    await expect(execute(["doctor", "--spool", "/tmp/x"])).rejects.toThrow("PORTFOLIO_SPOOL_INPUT_INVALID");
    await expect(execute(["doctor", "--orca-bin", "/bin/false"])).rejects.toThrow("PORTFOLIO_SPOOL_INPUT_INVALID");
  });
});
