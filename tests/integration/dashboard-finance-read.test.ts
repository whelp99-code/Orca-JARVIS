import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createPriceFinanceRuntime, type PriceHttpExchange, type PriceFinanceRuntime } from "../../src/integration/price-finance-production.js";
import { initialized } from "../helpers.js";
import type { AuthorityDb } from "../../src/db.js";

const company = `company_${"a".repeat(32)}`;
const body = '{"items":[],"read_only":true,"live_source_checked":false}';
const bindingBody = '{"candidate":null,"confirmed_connection":false}';
const wire = vi.fn<PriceHttpExchange>(async input => input.url.pathname === "/api/login"
  ? { status: 200, cookie: "price_session=test-only", body: JSON.stringify({ csrf: "test-only",
    companies: [{ id: company, role: "viewer" }] }) }
  : input.url.pathname === "/api/logout" ? { status: 200, body: "{}" }
    : { status: 200, body: input.url.pathname.endsWith("/crm-company-binding") ? bindingBody : body });
let db: AuthorityDb;
let server: DashboardServer;
let runtime: PriceFinanceRuntime;
let root: string;
let origin: string;
let csrf: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jarvis-price-route-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>test</title>");
  const path = join(root, "credential.json");
  writeFileSync(path, JSON.stringify({ origin: "http://127.0.0.1:4382", company_id: company,
    username: `jarvis_price_read_${company}`, password: "test-only-no-live-value",
    user_id: `user_${"b".repeat(32)}` }), { mode: 0o600 });
  runtime = createPriceFinanceRuntime(path, wire);
  db = await initialized();
  server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, priceFinance: runtime });
  origin = `http://127.0.0.1:${server.address.port}`;
  const session = await fetch(origin + "/api/v1/session").then(response => response.json());
  csrf = session.csrf_token;
});
beforeEach(() => { wire.mockClear(); });
afterAll(async () => {
  server?.close();
  await server?.drain();
  await runtime?.close();
  db?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});
const query = () => new URLSearchParams({ company_id: company, period_start: "2026-09-01",
  period_end: "2026-09-30", view: "discrepancy" });
describe("dashboard Price finance read boundary", () => {
  it("returns only non-secret configuration without contacting Price", async () => {
    const response = await fetch(origin + "/api/v1/finance-read/config", { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema_version: 1, configured: true, company_id: company });
    expect(wire).not.toHaveBeenCalled();
  });
  it("passes the native reader response through the real loopback route", async () => {
    const response = await fetch(origin + "/api/v1/finance-read?" + query(), { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.response_body).toBe(body);
    expect(receipt.request.company_id).toBe(company);
    expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("test-only");
  });
  it("reads native registration through the same local session boundary", async () => {
    const response = await fetch(origin + "/api/v1/finance-read/company-binding", { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.response_body).toBe(bindingBody);
    expect(receipt.company_id).toBe(company);
    expect(receipt.data).toEqual({ candidate: null, confirmed_connection: false });
    expect(wire.mock.calls.filter(([input]) => input.method === "GET")).toHaveLength(1);
    expect(wire.mock.calls.find(([input]) => input.method === "GET")?.[0].url.pathname)
      .toBe(`/api/companies/${company}/crm-company-binding`);
  });
  it("rejects unbound registration reads and caller-supplied company parameters", async () => {
    const path = origin + "/api/v1/finance-read/company-binding";
    const unbound = await fetch(path);
    const foreign = await fetch(path + "?company_id=foreign", { headers: { "x-jarvis-csrf": csrf } });
    expect(unbound.status).toBe(403);
    expect(foreign.status).toBe(400);
    expect(wire).not.toHaveBeenCalled();
  });
  it.each([
    { headers: new Headers() },
    { headers: new Headers({ origin: "https://foreign.invalid", "x-jarvis-csrf": "unused" }) },
  ])("rejects unbound or cross-origin reads before native authentication %#", async input => {
    const response = await fetch(origin + "/api/v1/finance-read?" + query(), input);
    expect(response.status).toBe(403);
    expect(wire).not.toHaveBeenCalled();
  });
  it("rejects a different company before contacting Price", async () => {
    const params = query(); params.set("company_id", "foreign");
    const response = await fetch(origin + "/api/v1/finance-read?" + params, { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CORE5_NATIVE_READ_SCOPE_DENIED");
    expect(wire).not.toHaveBeenCalled();
  });
  it("rejects writes despite valid local session and origin", async () => {
    const response = await fetch(origin + "/api/v1/finance-read", {
      method: "POST", headers: { origin, "x-jarvis-csrf": csrf, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(wire).not.toHaveBeenCalled();
  });
  it("rejects duplicate or extra query keys without a native read", async () => {
    for (const suffix of ["&company_id=foreign", "&method=POST"]) {
      const response = await fetch(origin + "/api/v1/finance-read?" + query() + suffix,
        { headers: { "x-jarvis-csrf": csrf } });
      expect(response.status).toBe(400);
    }
    expect(wire).not.toHaveBeenCalled();
  });
});
