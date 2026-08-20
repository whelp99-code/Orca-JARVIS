import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/index.js";
import { localReport, PORTFOLIO_AT } from "../fixtures/portfolio-report.js";
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function signedLocalEnvelope(key: Buffer, signature = ""): unknown {
  const producer = "jarvis-local";
  const report = localReport();
  const digest = signature || createHmac("sha256", key)
    .update(`${producer}\n${canonical(report)}`)
    .digest("hex");
  return {
    schema_version: 1,
    producer,
    report,
    signature: `hmac-sha256:${digest}`,
  };
}

describe("portfolio ingest CLI", () => {
  it("verifies an authenticated envelope before persisting the projection", async () => {
    const dbPath = await migrated();
    const auth = keyFile();
    const result = await execute(["portfolio", "ingest", "--source", "local", "--key-file", auth.path, "--db", dbPath], {
      clock: () => new Date(PORTFOLIO_AT),
      readStdin: async () => Buffer.from(JSON.stringify(signedLocalEnvelope(auth.key)), "utf8"),
    });
    expect(result).toMatchObject({ ok: true, command: "portfolio.ingest", environment: "local" });
    const db = new AuthorityDb(dbPath);
    const row = db.db.prepare("SELECT environment, producer, collector_status FROM dashboard_portfolio_projection WHERE environment='local'").get() as { environment: string; producer: string; collector_status: string };
    expect(row).toEqual({ environment: "local", producer: "jarvis-local", collector_status: "ok" });
    db.close();
  });

  it("rejects malformed stdin and source mismatch without writing a row", async () => {
    const dbPath = await migrated();
    const auth = keyFile();
    await expect(execute(["portfolio", "ingest", "--source", "local", "--key-file", auth.path, "--db", dbPath], {
      readStdin: async () => Buffer.from("{", "utf8"),
    })).rejects.toMatchObject({ code: "PORTFOLIO_INPUT_INVALID" });
    await expect(execute(["portfolio", "ingest", "--source", "jm-server", "--key-file", auth.path, "--db", dbPath], {
      readStdin: async () => Buffer.from(JSON.stringify(signedLocalEnvelope(auth.key)), "utf8"),
    })).rejects.toMatchObject({ code: "PORTFOLIO_SOURCE_MISMATCH" });
    const db = new AuthorityDb(dbPath);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM dashboard_portfolio_projection").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("rejects unsigned and invalidly signed reports without writing a row", async () => {
    const dbPath = await migrated();
    const auth = keyFile();
    await expect(execute(["portfolio", "ingest", "--source", "local", "--db", dbPath], {
      readStdin: async () => Buffer.from(JSON.stringify(localReport()), "utf8"),
    })).rejects.toMatchObject({ code: "PORTFOLIO_AUTH_REQUIRED" });
    await expect(execute(["portfolio", "ingest", "--source", "local", "--key-file", auth.path, "--db", dbPath], {
      readStdin: async () => Buffer.from(JSON.stringify(signedLocalEnvelope(auth.key, "0".repeat(64))), "utf8"),
    })).rejects.toMatchObject({ code: "PORTFOLIO_AUTH_INVALID" });
    const db = new AuthorityDb(dbPath);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM dashboard_portfolio_projection").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("checks migration readiness before authentication", async () => {
    const dbPath = tempDb();
    await expect(execute(["portfolio", "ingest", "--source", "local", "--db", dbPath], {
      readStdin: async () => Buffer.from(JSON.stringify(localReport()), "utf8"),
    })).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" });
  });
});
