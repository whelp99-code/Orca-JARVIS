import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { MailPersonalConnectorSource } from "../../src/personal-connector-mail-source.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import type { AuthorityDb } from "../../src/db.js";

const root = mkdtempSync(join(tmpdir(), "jarvis-mail-summary-http-"));
const token = "b".repeat(43);
const sessionFile = join(root, "mail-session");
const upstreamCalls: string[] = [];
let status = 200;
const upstream = createServer((req, res) => {
  upstreamCalls.push(`${req.method} ${req.url}`);
  const authorized = req.headers.cookie === `mi_session=${token}`;
  res.writeHead(authorized ? status : 403, { "content-type": "application/json" })
    .end(JSON.stringify({ ready: true, counts: { messages: 11, threads: 4 }, jobs: [{ body: "private" }] }));
});
let db: AuthorityDb;
let server: DashboardServer;
let unconfigured: DashboardServer;
let origin: string;
let csrf: string;
beforeAll(async () => {
  writeFileSync(sessionFile, token, { mode: 0o600 });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>test</title>");
  const listening = once(upstream, "listening");
  upstream.listen(0, "127.0.0.1");
  await listening;
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  db = await migratedTestDatabase(join(root, "authority.sqlite"));
  server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    mailSource: new MailPersonalConnectorSource({ base_url: `http://127.0.0.1:${address.port}`, session_file: sessionFile }) });
  unconfigured = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
  origin = `http://127.0.0.1:${server.address.port}`;
  csrf = (await fetch(origin + "/api/v1/session").then(response => response.json())).csrf_token;
});
afterAll(async () => {
  server.close();
  unconfigured.close();
  await Promise.all([server.drain(), unconfigured.drain()]);
  const closed = once(upstream, "close");
  upstream.close();
  await closed;
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const path = "/api/v1/connectors/mail";
describe("protected personal Mail summary GET", () => {
  it("returns configured metadata without upstream private fields", async () => {
    const response = await fetch(origin + path, { headers: { "x-jarvis-csrf": csrf } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({ connector_id: "mail", configured: true, state: "ready",
      values: { message_count: 11, thread_count: 4 } });
    expect(Object.keys(result.values).sort()).toEqual(["message_count", "observed_at", "thread_count"]);
    expect(upstreamCalls).toEqual(["GET /api/storage/status"]);
  });
  it("rejects missing session foreign origin overrides and writes before any upstream read", async () => {
    const before = upstreamCalls.length;
    const noSession = await fetch(origin + path);
    const foreign = await fetch(origin + path, { headers: { origin: "https://foreign.invalid", "x-jarvis-csrf": csrf } });
    const override = await fetch(origin + path + "?scope=all", { headers: { "x-jarvis-csrf": csrf } });
    const write = await fetch(origin + path, { method: "POST", headers: { "x-jarvis-csrf": csrf } });
    expect([noSession.status, foreign.status, override.status, write.status]).toEqual([403, 403, 400, 403]);
    expect(upstreamCalls.length).toBe(before);
  });
  it("reports refusal as unavailable rather than zero", async () => {
    status = 401;
    const result = await fetch(origin + path, { headers: { "x-jarvis-csrf": csrf } }).then(response => response.json());
    expect(result).toMatchObject({ configured: true, state: "unavailable", reason: "adapter_failed", values: {} });
  });
  it("does not advertise a connection when no mail configuration exists", async () => {
    const target = `http://127.0.0.1:${unconfigured.address.port}`;
    const session = await fetch(target + "/api/v1/session").then(response => response.json());
    const result = await fetch(target + path, { headers: { "x-jarvis-csrf": session.csrf_token } })
      .then(response => response.json());
    expect(result).toMatchObject({ configured: false, state: "unavailable", reason: "not_configured", values: {} });
  });
});
