import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createPhoneGatewayServer, parsePhoneGatewayConfig, PHONE_ERROR_CODES } from "../../src/phone-gateway.js";
import {
  FIXTURE_HOST,
  FIXTURE_LOGIN,
  FIXTURE_ORIGIN,
  cookieFromSetCookie,
  makePhoneHome,
  processUid,
  startFakeAuthority,
  json,
} from "../fixtures/phone-gateway-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function staticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-phone-mem-static-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ "index.html": { file: "assets/app.js" } }));
  writeFileSync(join(root, "assets", "app.js"), "1");
  return root;
}

async function authed(options: { now?: () => number; handler?: Parameters<typeof startFakeAuthority>[0] } = {}) {
  const files = makePhoneHome();
  roots.push(files.home);
  const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
  const authority = await startFakeAuthority(options.handler);
  const audits: string[] = [];
  const gateway = createPhoneGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstream: authority.origin,
    staticRoot: staticRoot(),
    config,
    now: options.now,
    audit: line => { audits.push(line); },
  });
  const origin = `http://127.0.0.1:${String(gateway.address.port)}`;
  const session = await request(`${origin}/api/v1/phone/session`, {
    headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN },
  });
  const cookieId = cookieFromSetCookie(session.headers["set-cookie"]);
  const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
  const headers = {
    Host: FIXTURE_HOST,
    "Tailscale-User-Login": FIXTURE_LOGIN,
    Origin: FIXTURE_ORIGIN,
    Cookie: `__Host-jarvis-phone=${cookieId ?? ""}`,
    "X-JARVIS-CSRF": csrf,
  };
  return { gateway, authority, origin, headers, csrf, audits };
}

describe("phone gateway Memory read adapter", () => {
  it("keeps scoped context disabled without configuration and rejects client identity claims", async () => {
    const value = await authed();
    try {
      const capabilities = await request(`${value.origin}/api/v1/memory/context/capabilities`, { headers: value.headers });
      expect(capabilities.statusCode).toBe(200);
      expect(await capabilities.body.json()).toEqual({ schema_version: 1, profile: "scoped-record-read-v2",
        configured: false, supported_operations: ["context"], writes_supported: false,
        authorization: "checked_per_request", readiness: "not_checked" });
      const anonymous = await request(`${value.origin}/api/v1/memory/context/capabilities`, {
        headers: { ...value.headers, Cookie: '' },
      });
      expect(anonymous.statusCode).toBe(401); await anonymous.body.text();
      for (const [extra, expected] of [[{}, 503], [{ agent_id: 'agent:attacker' }, 400]] as const) {
        const result = await request(`${value.origin}/api/v1/memory/context`, {
          method: 'POST', headers: { ...value.headers, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ schema_version: 1, query: 'Cited', limit: 2, max_bytes: 32768, ...extra }),
        });
        expect(result.statusCode).toBe(expected); await result.body.text();
      }
      expect(value.authority.captures.some(row => row.url === '/api/v1/memory/context')).toBe(false);
      expect(value.authority.captures.some(row => row.url === '/api/v1/memory/context/capabilities')).toBe(false);
    } finally { value.gateway.close(); await value.authority.close(); }
  });

  it("does not start a memory read if authentication expires during upstream bootstrap", async () => {
    let now = Date.parse("2026-09-09T00:00:00.000Z");
    let expireBootstrap = false;
    const value = await authed({ now: () => now, handler: (req, res) => {
      if (req.url !== "/api/v1/session" || !expireBootstrap) return false;
      now += 16 * 60_000;
      json(res, 200, { schema_version: 1, csrf_token: "rotated-csrf-token-bbbbbbbbbbbbbbbbbbbbbb" });
      return true;
    } });
    try {
      const normal = await request(`${value.origin}/api/v1/memory/status`, { headers: value.headers });
      expect(normal.statusCode).toBe(200); await normal.body.text();
      value.authority.csrf = "rotated-csrf-token-bbbbbbbbbbbbbbbbbbbbbb";
      const rotated = await request(`${value.origin}/api/v1/memory/status`, { headers: value.headers });
      expect(rotated.statusCode).toBe(503); await rotated.body.text();
      const before = value.authority.captures.filter(row => row.url === "/api/v1/memory/status").length;
      expireBootstrap = true;
      const expired = await request(`${value.origin}/api/v1/memory/status`, { headers: value.headers });
      expect(expired.statusCode).toBe(401); await expired.body.text();
      expect(value.authority.captures.filter(row => row.url === "/api/v1/memory/status")).toHaveLength(before);
    } finally { value.gateway.close(); await value.authority.close(); }
  });

  it("withholds an upstream memory response when the phone session expires in flight", async () => {
    let now = Date.parse("2026-09-09T00:00:00.000Z");
    const value = await authed({ now: () => now, handler: (request, response) => {
      if (request.url !== "/api/v1/memory/status") return false;
      now += 16 * 60_000;
      json(response, 200, { schema_version: 1, private_memory: "must-not-return-after-expiry" });
      return true;
    } });
    try {
      const result = await request(`${value.origin}/api/v1/memory/status`, { headers: value.headers });
      const body = await result.body.text();
      expect(result.statusCode).toBe(401);
      expect(body).toContain(PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED);
      expect(body).not.toContain("must-not-return-after-expiry");
      expect(String(result.headers["set-cookie"])).toContain("Max-Age=0");
    } finally { value.gateway.close(); await value.authority.close(); }
  });

  it("proxies the four Memory routes with reconstructed headers and exact POST bodies", async () => {
    const { gateway, authority, origin, headers, csrf, audits } = await authed();
    try {
      const searchBody = JSON.stringify({ schema_version: 1, query: "fixture-query", limit: 5 });
      const search = await request(`${origin}/api/v1/memory/search`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: searchBody,
      });
      expect(search.statusCode).toBe(200);
      const detailBody = JSON.stringify({ schema_version: 1, record_token: "a".repeat(43) });
      const detail = await request(`${origin}/api/v1/memory/records/detail`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: detailBody,
      });
      expect(detail.statusCode).toBe(200);
      const conflicts = await request(`${origin}/api/v1/memory/conflicts?limit=8`, { headers });
      expect(conflicts.statusCode).toBe(200);
      const status = await request(`${origin}/api/v1/memory/status`, { headers });
      expect(status.statusCode).toBe(200);
      const searchCap = authority.captures.find(entry => entry.url === "/api/v1/memory/search");
      const detailCap = authority.captures.find(entry => entry.url === "/api/v1/memory/records/detail");
      const conflictCap = authority.captures.find(entry => entry.url.startsWith("/api/v1/memory/conflicts"));
      const statusCap = authority.captures.find(entry => entry.url === "/api/v1/memory/status");
      expect(searchCap?.method).toBe("POST");
      expect(searchCap?.body.toString("utf8")).toBe(searchBody);
      expect(searchCap?.headers.origin).toBe(authority.origin);
      expect(searchCap?.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(searchCap?.headers["x-jarvis-csrf"]).toBe(authority.csrf);
      expect(searchCap?.headers["tailscale-user-login"]).toBeUndefined();
      expect(searchCap?.headers.cookie).toBeUndefined();
      expect(detailCap?.body.toString("utf8")).toBe(detailBody);
      expect(conflictCap?.body.byteLength).toBe(0);
      expect(statusCap?.body.byteLength).toBe(0);
      const clientSearch = await search.body.text();
      expect(clientSearch).not.toContain(authority.csrf);
      expect(clientSearch).not.toContain(csrf);
      expect(JSON.stringify(audits)).not.toContain("fixture-query");
      expect(JSON.stringify(audits)).not.toContain("a".repeat(43));
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("rejects old GET aliases, mutation POSTs, and oversized bodies before upstream", async () => {
    const { gateway, authority, origin, headers } = await authed();
    const before = authority.captures.length;
    try {
      const alias = await request(`${origin}/api/v1/memory/search?q=leak`, { headers });
      expect(alias.statusCode).toBe(404);
      const mutation = await request(`${origin}/api/v1/memory/records/x/forget`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ schema_version: 1 }),
      });
      expect(mutation.statusCode).toBe(404);
      const oversize = await request(`${origin}/api/v1/memory/search`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: Buffer.alloc(65_537, 0x61),
      });
      expect(oversize.statusCode).toBe(413);
      expect(authority.captures.length).toBe(before);
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("fails closed when the authority session rotates", async () => {
    const { gateway, authority, origin, headers } = await authed();
    try {
      authority.csrf = "rotated-csrf-token-bbbbbbbbbbbbbbbbbbbbbb";
      const status = await request(`${origin}/api/v1/memory/status`, { headers });
      expect([502, 503]).toContain(status.statusCode);
      const code = JSON.parse(await status.body.text()) as { error?: { code?: string } };
      expect(code.error?.code === PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID
        || code.error?.code === PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE).toBe(true);
    } finally {
      gateway.close();
      await authority.close();
    }
  });
});
