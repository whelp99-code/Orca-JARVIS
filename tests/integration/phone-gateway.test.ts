import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createPhoneGatewayServer, PHONE_ERROR_CODES } from "../../src/phone-gateway.js";
import { parsePhoneGatewayConfig } from "../../src/phone-gateway.js";
import {
  FIXTURE_HOST,
  FIXTURE_LOGIN,
  FIXTURE_ORIGIN,
  cookieFromSetCookie,
  makePhoneHome,
  processUid,
  rawHttp,
  startFakeAuthority,
} from "../fixtures/phone-gateway-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Gateway = ReturnType<typeof createPhoneGatewayServer>;

function originOf(server: Gateway): string {
  return `http://${server.address.host}:${String(server.address.port)}`;
}

function staticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-phone-static-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(root, "NOTICE-ARGO.txt"), "notice");
  writeFileSync(join(root, "assets", "app.js"), "globalThis.__PHONE__=1;");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    "index.html": { file: "assets/app.js" },
  }));
  return root;
}

async function boot(): Promise<{
  readonly gateway: Gateway;
  readonly authority: Awaited<ReturnType<typeof startFakeAuthority>>;
  readonly audits: string[];
}> {
  const files = makePhoneHome();
  roots.push(files.home);
  const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
  const authority = await startFakeAuthority();
  const audits: string[] = [];
  const gateway = createPhoneGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstream: authority.origin,
    staticRoot: staticRoot(),
    config,
    audit: line => { audits.push(line); },
  });
  return { gateway, authority, audits };
}

function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = Reflect.get(parsed, "error");
    if (typeof error !== "object" || error === null) return undefined;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

describe("phone gateway HTTP boundary", () => {
  it("binds IPv4 loopback independently from the authority listener", async () => {
    const first = await boot();
    const second = await boot();
    try {
      expect(first.gateway.address).toEqual({ host: "127.0.0.1", port: first.gateway.address.port, family: "IPv4" });
      expect(second.gateway.address.port).not.toBe(first.gateway.address.port);
      expect(first.gateway.address.port).not.toBe(first.authority.port);
      first.gateway.close();
      const health = await request(`${originOf(second.gateway)}/healthz`);
      expect(health.statusCode).toBe(200);
      expect(await health.body.json()).toEqual({ schema_version: 1, status: "ok" });
    } finally {
      second.gateway.close();
      await first.authority.close();
      await second.authority.close();
    }
  });

  it("bootstraps a session then reads Today projections without forwarding identity", async () => {
    const { gateway, authority, audits } = await boot();
    try {
      const session = await request(`${originOf(gateway)}/api/v1/phone/session`, {
        headers: {
          Host: FIXTURE_HOST,
          "Tailscale-User-Login": FIXTURE_LOGIN,
        },
      });
      expect(session.statusCode).toBe(200);
      const setCookie = session.headers["set-cookie"];
      const cookieId = cookieFromSetCookie(setCookie);
      const body = await session.body.json() as { csrf_token: string };
      expect(cookieId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const today = await request(`${originOf(gateway)}/api/v1/today`, {
        headers: {
          Host: FIXTURE_HOST,
          "Tailscale-User-Login": FIXTURE_LOGIN,
          Origin: FIXTURE_ORIGIN,
          Cookie: `__Host-jarvis-phone=${cookieId ?? ""}`,
          "X-JARVIS-CSRF": body.csrf_token,
        },
      });
      expect(today.statusCode).toBe(200);
      const forwarded = authority.captures.filter(entry => entry.url.startsWith("/api/v1/today"));
      expect(forwarded).toHaveLength(1);
      const headers = forwarded[0]?.headers ?? {};
      expect(headers["tailscale-user-login"]).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers.origin).toBeUndefined();
      expect(headers.host).toBe(`127.0.0.1:${String(authority.port)}`);
      expect(headers["x-jarvis-csrf"]).toBe(authority.csrf);
      expect(JSON.stringify(audits).toLowerCase()).not.toContain(FIXTURE_LOGIN.toLowerCase());
      expect(JSON.stringify(audits)).not.toContain(body.csrf_token);
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("rejects spoofed identity, forwarded headers, missing CSRF, and forbidden routes with zero upstream calls", async () => {
    const { gateway, authority } = await boot();
    await request(`${originOf(gateway)}/readyz`);
    const before = authority.captures.length;
    try {
      const wrong = await request(`${originOf(gateway)}/api/v1/phone/session`, {
        headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": "intruder@example.invalid" },
      });
      expect(wrong.statusCode).toBe(403);
      expect(errorCode(await wrong.body.text())).toBe(PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN);

      const forwarded = await request(`${originOf(gateway)}/api/v1/phone/session`, {
        headers: {
          Host: FIXTURE_HOST,
          "Tailscale-User-Login": FIXTURE_LOGIN,
          "X-Forwarded-For": "8.8.8.8",
        },
      });
      expect(forwarded.statusCode).toBe(403);
      expect(errorCode(await forwarded.body.text())).toBe(PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN);

      const raw = await rawHttp(gateway.address.port, [
        "GET /api/v1/phone/session HTTP/1.1",
        "Host: 127.0.0.1",
        `Tailscale-User-Login: ${FIXTURE_LOGIN}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      expect(raw.status).toBe(403);
      expect(errorCode(raw.body)).toBe(PHONE_ERROR_CODES.PHONE_HOST_FORBIDDEN);

      const session = await request(`${originOf(gateway)}/api/v1/phone/session`, {
        headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN },
      });
      const cookieId = cookieFromSetCookie(session.headers["set-cookie"]);
      const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
      const missingCsrf = await request(`${originOf(gateway)}/api/v1/today`, {
        headers: {
          Host: FIXTURE_HOST,
          "Tailscale-User-Login": FIXTURE_LOGIN,
          Cookie: `__Host-jarvis-phone=${cookieId ?? ""}`,
        },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(errorCode(await missingCsrf.body.text())).toBe(PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED);

      const terminal = await request(`${originOf(gateway)}/api/v1/agents/x/logs?limit=1`, {
        headers: {
          Host: FIXTURE_HOST,
          "Tailscale-User-Login": FIXTURE_LOGIN,
          Cookie: `__Host-jarvis-phone=${cookieId ?? ""}`,
          "X-JARVIS-CSRF": csrf,
        },
      });
      expect(terminal.statusCode).toBe(404);
      expect(errorCode(await terminal.body.text())).toBe(PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND);
      expect(authority.captures.length).toBe(before);
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("rate-limits pre-session bootstrap and does not call upstream after 429", async () => {
    const now = 0;
    const files = makePhoneHome();
    roots.push(files.home);
    const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    const authority = await startFakeAuthority();
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1",
      port: 0,
      upstream: authority.origin,
      staticRoot: staticRoot(),
      config,
      now: () => now,
    });
    try {
      const headers = { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN };
      for (let index = 0; index < 5; index += 1) {
        const response = await request(`${originOf(gateway)}/api/v1/phone/session`, { headers });
        expect(response.statusCode).toBe(200);
        await response.body.dump();
      }
      const limited = await request(`${originOf(gateway)}/api/v1/phone/session`, { headers });
      expect(limited.statusCode).toBe(429);
      expect(errorCode(await limited.body.text())).toBe(PHONE_ERROR_CODES.PHONE_RATE_LIMITED);
      expect(authority.captures.every(entry => entry.url === "/api/v1/session")).toBe(true);
    } finally {
      gateway.close();
      await authority.close();
    }
  });
});
