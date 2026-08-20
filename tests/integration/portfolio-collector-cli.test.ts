import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import { collectorError, PORTFOLIO_AT } from "../fixtures/portfolio-report.js";
import { tempDb } from "../helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function migrated(): Promise<string> {
  const path = tempDb();
  const db = new AuthorityDb(path);
  await db.migrate();
  db.close();
  return path;
}

function keyFile(): { key: Buffer; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-portfolio-key-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "local.key");
  const key = Buffer.alloc(32, 0x5a);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { key, path };
}

describe("portfolio collector error envelope CLI integration", () => {
  it("persists a correctly signed collector-error envelope as error status", async () => {
    const dbPath = await migrated();
    const auth = keyFile();
    const envelope = signPortfolioEnvelope(collectorError("local", { reported_at: PORTFOLIO_AT }), auth.key);
    const result = await execute(["portfolio", "ingest", "--source", "local", "--key-file", auth.path, "--db", dbPath], {
      clock: () => new Date(PORTFOLIO_AT),
      readStdin: async () => Buffer.from(JSON.stringify(envelope), "utf8"),
    });
    expect(result).toMatchObject({ ok: true, command: "portfolio.ingest", environment: "local" });
    const db = new AuthorityDb(dbPath);
    const row = db.db.prepare("SELECT environment, producer, collector_status, collector_error, last_success_snapshot_json FROM dashboard_portfolio_projection WHERE environment='local'").get() as {
      environment: string;
      producer: string;
      collector_status: string;
      collector_error: string;
      last_success_snapshot_json: string | null;
    };
    expect(row).toMatchObject({
      environment: "local",
      producer: "jarvis-local",
      collector_status: "error",
      collector_error: "ORCA_UNAVAILABLE",
      last_success_snapshot_json: null,
    });
    db.close();
  });
});
