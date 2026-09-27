import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPhoneGatewayServer, parsePhoneGatewayConfig, PHONE_ERROR_CODES } from "../../src/phone-gateway.js";
import {
  FIXTURE_LOGIN,
  cookieFromSetCookie,
  makePhoneHome,
  processUid,
  startFakeAuthority,
} from "../fixtures/phone-gateway-harness.js";

const PUBLIC_HOST = "jarvis-fixture.example.invalid:8444";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const SERVE_IPV4 = "100.87.81.57";
const NAVIGATE = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const roots: string[] = [];
let buildRoot = "";

beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "jarvis-dashboard-build-"));
  execFileSync(process.execPath, [
    resolve("node_modules/vite/bin/vite.js"), "build", "--config", "dashboard/vite.config.ts", "--outDir", buildRoot, "--logLevel", "error",
  ], { stdio: "pipe" });
});

afterAll(() => {
  rmSync(buildRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(now?: () => number) {
  const files = makePhoneHome(undefined, PUBLIC_ORIGIN);
  roots.push(files.home);
  const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
  const authority = await startFakeAuthority();
  const audits: string[] = [];
  const gateway = createPhoneGatewayServer({
    host: "127.0.0.1", port: 0, upstream: authority.origin, staticRoot: buildRoot, config,
    audit: line => { audits.push(line); }, ...(now === undefined ? {} : { now }),
  });
  const origin = `http://127.0.0.1:${String(gateway.address.port)}`;
  return { gateway, authority, audits, origin, close: async () => { gateway.close(); await authority.close(); } };
}

function serveHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Host: PUBLIC_HOST,
    "Tailscale-User-Login": FIXTURE_LOGIN,
    "X-Forwarded-For": SERVE_IPV4,
    "X-Forwarded-Host": PUBLIC_HOST,
    "X-Forwarded-Proto": "https",
    Accept: NAVIGATE,
    ...overrides,
  };
}

function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "error") : undefined;
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function manifestAssets(): ReadonlySet<string> {
  const manifest = JSON.parse(readFileSync(join(buildRoot, "manifest.json"), "utf8")) as Record<string, { file: string; css?: string[] }>;
  const names = new Set<string>();
  for (const entry of Object.values(manifest)) {
    names.add(`/${entry.file}`);
    for (const css of entry.css ?? []) names.add(`/${css}`);
  }
  return names;
}

function referencedAssets(html: string): { readonly script: string; readonly css: string } {
  const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const css = /<link[^>]+href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  if (script === undefined || css === undefined) throw new Error(`document references: ${html}`);
  return { script, css };
}

describe("phone gateway serves the built dashboard document to a tailnet browser", () => {
  it.each(["/", "/memory"])("bootstraps a session and serves index.html for an HTML navigation to %s", async (path) => {
    // Given the Serve header set, an HTML Accept and no cookie
    const fixture = await boot();
    try {
      // When the browser navigates
      const response = await request(`${fixture.origin}${path}`, { headers: serveHeaders() });
      const html = await response.body.text();
      // Then the real document is served with a fresh session cookie
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
      const setCookie = response.headers["set-cookie"];
      const cookieId = cookieFromSetCookie(setCookie);
      expect(cookieId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(String(setCookie)).toContain("Secure; HttpOnly; SameSite=Strict");
      expect(html).toContain("<meta name=\"jarvis-phone-mode\" content=\"1\"");
      expect(html).toContain("<div id=\"root\">");
      const assets = referencedAssets(html);
      const listed = manifestAssets();
      expect(listed.has(assets.script)).toBe(true);
      expect(listed.has(assets.css)).toBe(true);
      expect(html).not.toContain(FIXTURE_LOGIN);
      expect(fixture.authority.captures.filter(entry => entry.url === path)).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("serves the referenced script and stylesheet to the bootstrapped session", async () => {
    // Given a bootstrapped document
    const fixture = await boot();
    try {
      const document = await request(`${fixture.origin}/`, { headers: serveHeaders() });
      const cookieId = cookieFromSetCookie(document.headers["set-cookie"]) ?? "";
      const assets = referencedAssets(await document.body.text());
      const headers = serveHeaders({ Accept: "*/*", Cookie: `__Host-jarvis-phone=${cookieId}` });
      // When the browser fetches the assets the document references
      const script = await request(`${fixture.origin}${assets.script}`, { headers });
      const css = await request(`${fixture.origin}${assets.css}`, { headers });
      // Then both are the built bytes
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(await script.body.text()).toBe(readFileSync(join(buildRoot, assets.script.slice(1)), "utf8"));
      expect(css.statusCode).toBe(200);
      expect(await css.body.text()).toBe(readFileSync(join(buildRoot, assets.css.slice(1)), "utf8"));
    } finally {
      await fixture.close();
    }
  });

  it("lets the loaded SPA bootstrap CSRF and read Today and Memory with session plus CSRF", async () => {
    // Given the navigation session
    const fixture = await boot();
    try {
      const document = await request(`${fixture.origin}/`, { headers: serveHeaders() });
      await document.body.dump();
      const navCookie = cookieFromSetCookie(document.headers["set-cookie"]) ?? "";
      // When the SPA calls the session route with the navigation cookie
      const session = await request(`${fixture.origin}/api/v1/phone/session`, {
        headers: serveHeaders({ Accept: "application/json", Cookie: `__Host-jarvis-phone=${navCookie}` }),
      });
      expect(session.statusCode).toBe(200);
      const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
      const cookieId = cookieFromSetCookie(session.headers["set-cookie"]) ?? "";
      const api = serveHeaders({ Accept: "application/json", Cookie: `__Host-jarvis-phone=${cookieId}`,
        "X-JARVIS-CSRF": csrf, Origin: PUBLIC_ORIGIN });
      // Then the read routes the SPA uses answer 200
      const today = await request(`${fixture.origin}/api/v1/today`, { headers: api });
      expect(today.statusCode).toBe(200);
      await today.body.dump();
      const status = await request(`${fixture.origin}/api/v1/memory/status`, { headers: api });
      expect(status.statusCode).toBe(200);
      await status.body.dump();
      const conflicts = await request(`${fixture.origin}/api/v1/memory/conflicts?limit=20`, { headers: api });
      expect(conflicts.statusCode).toBe(200);
      await conflicts.body.dump();
      const search = await request(`${fixture.origin}/api/v1/memory/search`, {
        method: "POST", headers: { ...api, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ schema_version: 1, query: "evidence", limit: 20 }),
      });
      expect(search.statusCode).toBe(200);
      await search.body.dump();
      expect(JSON.stringify(fixture.audits)).not.toContain(csrf);
      expect(JSON.stringify(fixture.audits).toLowerCase()).not.toContain(FIXTURE_LOGIN.toLowerCase());
    } finally {
      await fixture.close();
    }
  });

  it("keeps an existing session on a repeat navigation instead of minting another", async () => {
    // Given a bootstrapped session
    const fixture = await boot();
    try {
      const first = await request(`${fixture.origin}/`, { headers: serveHeaders() });
      await first.body.dump();
      const cookieId = cookieFromSetCookie(first.headers["set-cookie"]) ?? "";
      // When the browser navigates again with the cookie
      const second = await request(`${fixture.origin}/memory`, {
        headers: serveHeaders({ Cookie: `__Host-jarvis-phone=${cookieId}` }),
      });
      await second.body.dump();
      // Then the same session is refreshed, not replaced
      expect(second.statusCode).toBe(200);
      expect(cookieFromSetCookie(second.headers["set-cookie"])).toBe(cookieId);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["missing identity", { "Tailscale-User-Login": "" }, 401, PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED],
    ["wrong owner", { "Tailscale-User-Login": "intruder@example.invalid" }, 403, PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN],
    ["spoofed client", { "X-Forwarded-For": "8.8.8.8" }, 403, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["extra Forwarded", { Forwarded: "for=8.8.8.8" }, 403, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["wrong host", { Host: "evil.example:8444" }, 403, PHONE_ERROR_CODES.PHONE_HOST_FORBIDDEN],
  ])("rejects an HTML navigation without a trusted owner: %s", async (_name, overrides, status, code) => {
    const fixture = await boot();
    try {
      const response = await request(`${fixture.origin}/`, { headers: serveHeaders(overrides) });
      expect(response.statusCode).toBe(status);
      expect(errorCode(await response.body.text())).toBe(code);
      expect(cookieFromSetCookie(response.headers["set-cookie"])).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("still requires a session for a non-HTML read and for API routes", async () => {
    const fixture = await boot();
    try {
      // Given no cookie and a JSON Accept
      const shell = await request(`${fixture.origin}/`, { headers: serveHeaders({ Accept: "application/json" }) });
      expect(shell.statusCode).toBe(401);
      expect(errorCode(await shell.body.text())).toBe(PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED);
      expect(cookieFromSetCookie(shell.headers["set-cookie"])).toBeUndefined();
      // And an HTML navigation to an API route
      const api = await request(`${fixture.origin}/api/v1/today`, { headers: serveHeaders() });
      expect(api.statusCode).toBe(401);
      expect(errorCode(await api.body.text())).toBe(PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED);
      expect(cookieFromSetCookie(api.headers["set-cookie"])).toBeUndefined();
      // And a forbidden route
      const forbidden = await request(`${fixture.origin}/terminal`, { headers: serveHeaders() });
      expect(forbidden.statusCode).toBe(404);
      expect(errorCode(await forbidden.body.text())).toBe(PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND);
      expect(fixture.authority.captures.filter(entry => entry.url !== "/api/v1/health" && entry.url !== "/api/v1/session")).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("rate-limits pre-session navigations like the session route", async () => {
    const fixture = await boot(() => 0);
    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await request(`${fixture.origin}/`, { headers: serveHeaders() });
        expect(response.statusCode).toBe(200);
        await response.body.dump();
      }
      const limited = await request(`${fixture.origin}/`, { headers: serveHeaders() });
      expect(limited.statusCode).toBe(429);
      expect(errorCode(await limited.body.text())).toBe(PHONE_ERROR_CODES.PHONE_RATE_LIMITED);
    } finally {
      await fixture.close();
    }
  });
});
