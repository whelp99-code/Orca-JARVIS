import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
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
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function staticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-phone-static-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), [
    "<!doctype html><html><head><title>fixture</title></head>",
    "<body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
  ].join(""));
  writeFileSync(join(root, "assets", "app.js"), "globalThis.__PHONE__=1;");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ "index.html": { file: "assets/app.js" } }));
  return root;
}

async function boot() {
  const files = makePhoneHome();
  roots.push(files.home);
  writeFileSync(files.envFile, [
    `JARVIS_PHONE_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}`,
    `JARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}`,
    `JARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}`,
    "",
  ].join("\n"));
  chmodSync(files.envFile, 0o600);
  const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
  const authority = await startFakeAuthority();
  const gateway = createPhoneGatewayServer({
    host: "127.0.0.1",
    port: 0,
    upstream: authority.origin,
    staticRoot: staticRoot(),
    config,
  });
  return { gateway, authority, config };
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

function serveHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Host: PUBLIC_HOST,
    "Tailscale-User-Login": FIXTURE_LOGIN,
    "X-Forwarded-For": SERVE_IPV4,
    "X-Forwarded-Host": PUBLIC_HOST,
    "X-Forwarded-Proto": "https",
    Origin: PUBLIC_ORIGIN,
    ...overrides,
  };
}

function rawFrom(localAddress: string, port: number, payload: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress });
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => {
      const split = data.indexOf("\r\n\r\n");
      const head = split === -1 ? data : data.slice(0, split);
      const body = split === -1 ? "" : data.slice(split + 4);
      resolve({ status: Number(/HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0), body });
    });
    socket.on("connect", () => socket.end(payload));
  });
}

describe("gateway replay of Tailscale Serve headers", () => {
  it("accepts the Serve header set and the configured :8444 origin", async () => {
    const { gateway, authority } = await boot();
    try {
      const session = await request(`http://127.0.0.1:${String(gateway.address.port)}/api/v1/phone/session`, {
        headers: serveHeaders(),
      });
      expect(session.statusCode).toBe(200);
      const body = await session.body.text();
      expect(errorCode(body)).toBeUndefined();
      expect(JSON.parse(body)).toMatchObject({ schema_version: 1 });
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("serves the release document for Today and Memory after a Serve-header session", async () => {
    const { gateway, authority } = await boot();
    try {
      const origin = `http://127.0.0.1:${String(gateway.address.port)}`;
      const session = await request(`${origin}/api/v1/phone/session`, { headers: serveHeaders() });
      expect(session.statusCode).toBe(200);
      const cookieId = cookieFromSetCookie(session.headers["set-cookie"]);
      await session.body.dump();
      const shellHeaders = {
        ...serveHeaders(),
        Cookie: `__Host-jarvis-phone=${cookieId ?? ""}`,
      };
      const today = await request(`${origin}/`, { headers: shellHeaders });
      const memory = await request(`${origin}/memory`, { headers: shellHeaders });
      expect(today.statusCode).toBe(200);
      expect(memory.statusCode).toBe(200);
      const todayHtml = await today.body.text();
      const memoryHtml = await memory.body.text();
      expect(todayHtml).toContain("<meta name=\"jarvis-phone-mode\" content=\"1\"");
      expect(todayHtml).toContain("src=\"/assets/app.js\"");
      expect(memoryHtml).toBe(todayHtml);
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it.each([
    ["spoofed client", { "X-Forwarded-For": "8.8.8.8" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["wrong host", { "X-Forwarded-Host": "evil.example:8444" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["http proto", { "X-Forwarded-Proto": "http" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["duplicate for", { "X-Forwarded-For": `${SERVE_IPV4}, ${SERVE_IPV4}` }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["extra Forwarded", { Forwarded: "for=8.8.8.8" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["extra X-Real-IP", { "X-Real-IP": "8.8.8.8" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
    ["extra Via", { Via: "1.1 spoof" }, PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN],
  ])("rejects Serve header tampering: %s", async (_name, overrides, code) => {
    const { gateway, authority } = await boot();
    const ready = await request(`http://127.0.0.1:${String(gateway.address.port)}/readyz`);
    await ready.body.dump();
    const before = authority.captures.length;
    try {
      const response = await request(`http://127.0.0.1:${String(gateway.address.port)}/api/v1/phone/session`, {
        headers: serveHeaders(overrides),
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(await response.body.text())).toBe(code);
      expect(authority.captures).toHaveLength(before);
    } finally {
      gateway.close();
      await authority.close();
    }
  });

  it("rejects a non-loopback peer that presents the Serve header set", async () => {
    const { gateway, authority } = await boot();
    try {
      const raw = await rawFrom("127.0.0.2", gateway.address.port, [
        "GET /api/v1/phone/session HTTP/1.1",
        `Host: ${PUBLIC_HOST}`,
        `Tailscale-User-Login: ${FIXTURE_LOGIN}`,
        `X-Forwarded-For: ${SERVE_IPV4}`,
        `X-Forwarded-Host: ${PUBLIC_HOST}`,
        "X-Forwarded-Proto: https",
        `Origin: ${PUBLIC_ORIGIN}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      expect(raw.status).toBe(403);
      expect(errorCode(raw.body)).toBe(PHONE_ERROR_CODES.PHONE_PROXY_REQUIRED);
    } finally {
      gateway.close();
      await authority.close();
    }
  });
});
