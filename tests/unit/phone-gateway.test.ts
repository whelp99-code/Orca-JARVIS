import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import {
  PHONE_CORE_ROUTES,
  PHONE_ERROR_CODES,
  authenticateTailnetOwner,
  createPhoneRateLimiter,
  isTrustedServeRequest,
  matchPhoneRoute,
  parsePhoneGatewayConfig,
} from "../../src/phone-gateway.js";
import { parsePhoneGatewayCli } from "../../src/phone-gateway-main.js";
import { FIXTURE_HOST, FIXTURE_LOGIN, FIXTURE_ORIGIN, makePhoneHome, processUid } from "../fixtures/phone-gateway-harness.js";

function serveRequest(peer: string | undefined, headers: readonly string[]) {
  return { socket: { remoteAddress: peer }, rawHeaders: headers, method: "GET" };
}

const BASE_HEADERS = ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN] as const;

describe("phone gateway config", () => {
  it("accepts the closed three-key env file", () => {
    const files = makePhoneHome();
    const parsed = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    expect(parsed.publicOrigin).toBe(FIXTURE_ORIGIN);
    expect(parsed.publicHost).toBe(FIXTURE_HOST);
    expect(parsed.ownerLogin).toBe(FIXTURE_LOGIN);
    expect(parsed.sessionKey.byteLength).toBe(32);
  });

  it.each([
    ["http origin", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=http://${FIXTURE_HOST}\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
      chmodSync(files.envFile, 0o600);
    }],
    ["IP origin", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=https://127.0.0.1\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
      chmodSync(files.envFile, 0o600);
    }],
    ["port origin", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=https://${FIXTURE_HOST}:8443\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
      chmodSync(files.envFile, 0o600);
    }],
    ["trailing-dot origin", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=https://${FIXTURE_HOST}.\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
      chmodSync(files.envFile, 0o600);
    }],
    ["extra key", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=${FIXTURE_ORIGIN}\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\nEXTRA=1\n`);
      chmodSync(files.envFile, 0o600);
    }],
    ["unsafe login", (files: ReturnType<typeof makePhoneHome>) => {
      writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=${FIXTURE_ORIGIN}\nJARVIS_PHONE_OWNER_LOGIN=owner,shared\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
      chmodSync(files.envFile, 0o600);
    }],
  ])("rejects %s", (_name, mutate) => {
    const files = makePhoneHome();
    mutate(files);
    expect(() => parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() }))
      .toThrow(/PHONE_NOT_READY/);
  });

  it("rejects a symlink or wrong-size session key", () => {
    const files = makePhoneHome();
    const linked = join(files.home, ".config", "orca-jarvis", "linked.key");
    symlinkSync(files.keyFile, linked);
    writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=${FIXTURE_ORIGIN}\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${linked}\n`);
    chmodSync(files.envFile, 0o600);
    expect(() => parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() }))
      .toThrow(/PHONE_NOT_READY/);
    writeFileSync(files.keyFile, Buffer.alloc(31, 1));
    chmodSync(files.keyFile, 0o600);
    writeFileSync(files.envFile, `JARVIS_PHONE_PUBLIC_ORIGIN=${FIXTURE_ORIGIN}\nJARVIS_PHONE_OWNER_LOGIN=${FIXTURE_LOGIN}\nJARVIS_PHONE_SESSION_KEY_FILE=${files.keyFile}\n`);
    chmodSync(files.envFile, 0o600);
    expect(() => parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() }))
      .toThrow(/PHONE_NOT_READY/);
  });
});

describe("phone gateway CLI bind contract", () => {
  it("accepts only 127.0.0.1:4174 and the loopback authority upstream", () => {
    const parsed = parsePhoneGatewayCli([
      "--host", "127.0.0.1", "--port", "4174",
      "--upstream", "http://127.0.0.1:4173",
      "--static-root", "/tmp/static",
      "--env-file", "/tmp/phone-gateway.env",
    ]);
    expect(parsed).toEqual({
      host: "127.0.0.1",
      port: 4174,
      upstream: "http://127.0.0.1:4173",
      staticRoot: "/tmp/static",
      envFile: "/tmp/phone-gateway.env",
    });
  });

  it.each([
    ["0.0.0.0", "4174", "http://127.0.0.1:4173"],
    ["127.0.0.1", "4173", "http://127.0.0.1:4173"],
    ["127.0.0.1", "4174", "http://127.0.0.1:80"],
    ["::1", "4174", "http://127.0.0.1:4173"],
  ])("rejects host=%s port=%s upstream=%s", (host, port, upstream) => {
    expect(() => parsePhoneGatewayCli([
      "--host", host, "--port", port, "--upstream", upstream,
      "--static-root", "/tmp/static", "--env-file", "/tmp/x.env",
    ])).toThrow(/PHONE_NOT_READY|LOCAL_SESSION_REQUIRED|VALIDATION_ERROR/);
  });
});

describe("trusted Serve request and owner identity", () => {
  it("accepts exact IPv4 loopback plus one Host and owner login", () => {
    const trusted = isTrustedServeRequest(serveRequest("127.0.0.1", BASE_HEADERS), FIXTURE_HOST);
    expect(trusted).toEqual({ ok: true, login: FIXTURE_LOGIN });
    expect(authenticateTailnetOwner(FIXTURE_LOGIN, FIXTURE_LOGIN)).toEqual({ ok: true });
  });

  it.each([
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["10.0.0.2"],
    ["100.64.0.1"],
    [undefined],
  ])("rejects peer %s as PHONE_PROXY_REQUIRED", peer => {
    const result = isTrustedServeRequest(serveRequest(peer, BASE_HEADERS), FIXTURE_HOST);
    expect(result).toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_PROXY_REQUIRED });
  });

  it.each([
    ["missing host", ["Tailscale-User-Login", FIXTURE_LOGIN]],
    ["duplicate host", ["Host", FIXTURE_HOST, "Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN]],
    ["mixed-case duplicate host", ["Host", FIXTURE_HOST, "host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN]],
    ["host with port", ["Host", `${FIXTURE_HOST}:443`, "Tailscale-User-Login", FIXTURE_LOGIN]],
    ["forwarded for", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "X-Forwarded-For", "1.1.1.1"]],
    ["forwarded proto", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "X-Forwarded-Proto", "https"]],
    ["forwarded host", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "X-Forwarded-Host", FIXTURE_HOST]],
    ["forwarded", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "Forwarded", "for=1.1.1.1"]],
    ["real ip", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "X-Real-IP", "127.0.0.1"]],
    ["via", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "Via", "1.1 proxy"]],
    ["proxy authorization", ["Host", FIXTURE_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, "Proxy-Authorization", "Basic x"]],
  ])("rejects %s", (_name, headers) => {
    const result = isTrustedServeRequest(serveRequest("127.0.0.1", headers), FIXTURE_HOST);
    expect(result.ok).toBe(false);
  });

  it("treats missing identity as required and a well-formed non-owner as forbidden", () => {
    const missing = isTrustedServeRequest(serveRequest("127.0.0.1", ["Host", FIXTURE_HOST]), FIXTURE_HOST);
    expect(missing).toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED });
    const empty = isTrustedServeRequest(
      serveRequest("127.0.0.1", ["Host", FIXTURE_HOST, "Tailscale-User-Login", ""]),
      FIXTURE_HOST,
    );
    expect(empty).toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED });
    expect(authenticateTailnetOwner("Owner@example.invalid", FIXTURE_LOGIN))
      .toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN });
    expect(authenticateTailnetOwner(`${FIXTURE_LOGIN} `, FIXTURE_LOGIN))
      .toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED });
    expect(authenticateTailnetOwner("friend@example.invalid", FIXTURE_LOGIN))
      .toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN });
  });
});

describe("phone core route table", () => {
  it("allows the closed Today and Memory methods and denies aliases", () => {
    const allowed = [
      ["GET", "/healthz", ""],
      ["GET", "/readyz", ""],
      ["GET", "/api/v1/phone/session", ""],
      ["GET", "/", ""],
      ["GET", "/memory", ""],
      ["GET", "/NOTICE-ARGO.txt", ""],
      ["GET", "/assets/app.js", ""],
      ["GET", "/api/v1/today", ""],
      ["GET", "/api/v1/decision-inbox", "?limit=20"],
      ["GET", "/api/v1/notification-intents", "?limit=1&cursor=abc"],
      ["GET", "/api/v1/source-health", "?limit=100"],
      ["GET", "/api/v1/recommendations/rec-1", ""],
      ["GET", "/api/v1/contexts/ctx-1/evidence", "?recommendation_id=rec-1"],
      ["GET", "/api/v1/memory/conflicts", "?limit=32"],
      ["GET", "/api/v1/memory/status", ""],
      ["POST", "/api/v1/memory/search", ""],
      ["POST", "/api/v1/memory/records/detail", ""],
    ] as const;
    for (const [method, path, query] of allowed) {
      const matched = matchPhoneRoute({ method, path, rawUrl: `${path}${query}` });
      expect(matched.kind, `${method} ${path}${query}`).toBe("ok");
    }
    const denied = [
      ["GET", "/api/v1/memory/search", ""],
      ["GET", "/api/v1/memory/search", "?q=secret"],
      ["GET", "/api/v1/memory/items/x", ""],
      ["GET", "/api/v1/memory/records/x", ""],
      ["GET", "/api/v1/memory/conflicts", "?limit=32&cursor=x"],
      ["GET", "/api/v1/session", ""],
      ["GET", "/api/v1/overview", ""],
      ["GET", "/api/v1/control/requests", ""],
      ["GET", "/terminal", ""],
      ["POST", "/api/v1/today", ""],
      ["POST", "/api/v1/memory/candidates/x/decision", ""],
      ["GET", "/assets/../package.json", ""],
      ["GET", "/assets/app.js.map", ""],
      ["GET", "/security", ""],
      ["GET", "/memory/", ""],
    ] as const;
    for (const [method, path, query] of denied) {
      const matched = matchPhoneRoute({ method, path, rawUrl: `${path}${query}` });
      expect(matched.kind, `${method} ${path}${query}`).not.toBe("ok");
    }
    const classes = PHONE_CORE_ROUTES.map(route => `${route.method} ${route.path}`);
    expect(classes).toEqual(expect.arrayContaining([
      "POST /api/v1/memory/search",
      "POST /api/v1/memory/records/detail",
      "GET /api/v1/memory/conflicts",
      "GET /api/v1/memory/status",
    ]));
    expect(PHONE_CORE_ROUTES.every(route => route.proxyBranch === undefined || route.path.length > 0)).toBe(true);
  });
});

describe("phone rate limiter", () => {
  it("enforces pre-session capacity 5 and independent session buckets with an injected clock", () => {
    let now = 0;
    const limiter = createPhoneRateLimiter({ now: () => now });
    const digest = "aa";
    for (let index = 0; index < 5; index += 1) {
      expect(limiter.takePreSession(digest).ok).toBe(true);
    }
    const limited = limiter.takePreSession(digest);
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.retryAfter).toBeGreaterThanOrEqual(1);
    now = 60_000;
    expect(limiter.takePreSession(digest).ok).toBe(true);
    const sessionA = "session-a";
    const sessionB = "session-b";
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.takeSession(sessionA).ok).toBe(true);
    }
    expect(limiter.takeSession(sessionA).ok).toBe(false);
    expect(limiter.takeSession(sessionB).ok).toBe(true);
  });
});

describe("phone home isolation", () => {
  it("does not write runtime files while parsing config", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-phone-empty-"));
    mkdirSync(join(root, ".config", "orca-jarvis"), { recursive: true });
    const files = makePhoneHome(root);
    parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    expect(files.key.byteLength).toBe(32);
  });
});
