import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import type { PriceFinanceRuntime } from "../../src/integration/price-finance-production.js";
import { NativeFinanceReader } from "../../src/integration/native-finance-read.js";
import type { MailCandidatesSummary } from "../../src/integration/mail-candidates-contract.js";
import { productHubSchema } from "../../src/dashboard/product-hub-contract.js";
import { parseDashboardSession } from "../../src/dashboard/session.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import type { AuthorityDb } from "../../src/db.js";

const root = mkdtempSync(join(tmpdir(), "jarvis-product-hub-"));
const NOW = "2026-10-16T00:00:00.000Z";
let db: AuthorityDb;
let server: DashboardServer;
let origin: string;
let csrf: string;
let priceReads = 0;

const summary: MailCandidatesSummary = {
  schema_version: 1, proof_level: "native-read", authority: "none", observed_at: NOW,
  crm: {
    state: "read", workspace_id: "44444444-4444-4444-8444-444444444444", candidate_count: 1,
    recent: [{ id: "private-id", status: "open", confirmed: false, freshness: "live", createdAt: NOW }],
  },
  sb: { state: "unconnected", reason: "unconfigured" },
};

beforeAll(async () => {
  writeFileSync(join(root, "index.html"), "<!doctype html><title>test</title>");
  db = await migratedTestDatabase(join(root, "authority.sqlite"));
  new MemoryProjectionAuthority(db).initialize(new Date(NOW));
  db.db.prepare(`INSERT INTO control_command_requests
    (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
    VALUES ('hub-1','workflow.start',2,'{}','{}',? ,1,'test',?,?,?,'pending',?)`)
    .run("sha256:" + "ef".repeat(32), NOW, "2026-10-17T00:00:00.000Z", "hub-nonce", NOW);
  const priceFinance = {
    company_id: "private-company",
    reader: new NativeFinanceReader("private-company", {
      get: async () => { priceReads += 1; throw new Error("price read"); },
    }, () => "fixture"),
    readCompanyBinding: async () => { priceReads += 1; throw new Error("price read"); },
    close: async () => {},
  } satisfies PriceFinanceRuntime;
  server = createDashboardServer({
    db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => new Date(NOW),
    priceFinance,
    mailCandidates: { read: async () => summary, close() {} },
  });
  origin = `http://127.0.0.1:${server.address.port}`;
  const session = parseDashboardSession(await fetch(origin + "/api/v1/session").then(response => response.json()));
  if (session === undefined) throw new Error("fixture session invalid");
  csrf = session.csrf_token;
});

afterAll(async () => {
  server.close();
  await server.drain();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("product hub GET", () => {
  it("returns the closed projection without price calls or source identities", async () => {
    const before = db.db.serialize();
    const response = await fetch(origin + "/api/v1/product-hub", { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = productHubSchema.parse(await response.json());
    expect(body.items.find(item => item.id === "crm")).toMatchObject({ state: "ready", count: 1 });
    expect(body.items.find(item => item.id === "price")).toMatchObject({ state: "configured", count: null });
    expect(body.items.find(item => item.id === "approvals")).toMatchObject({ state: "ready", count: 1 });
    expect(priceReads).toBe(0);
    expect(JSON.stringify(body)).not.toContain("private");
    expect(db.db.serialize().equals(before)).toBe(true);
  });

  it("denies a missing csrf, a foreign origin, a query, and a write", async () => {
    const missing = await fetch(origin + "/api/v1/product-hub");
    const foreign = await fetch(origin + "/api/v1/product-hub", {
      headers: { origin: "https://foreign.invalid", "x-jarvis-csrf": csrf },
    });
    const query = await fetch(origin + "/api/v1/product-hub?scope=all", { headers: { "x-jarvis-csrf": csrf } });
    const post = await fetch(origin + "/api/v1/product-hub", { method: "POST", headers: { "x-jarvis-csrf": csrf } });
    expect(missing.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(query.status).toBe(400);
    expect(post.status).toBe(403);
    expect(priceReads).toBe(0);
  });
});
