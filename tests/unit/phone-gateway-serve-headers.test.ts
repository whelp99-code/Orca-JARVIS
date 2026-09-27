import { describe, expect, it } from "vitest";
import { PHONE_ERROR_CODES, isTrustedServeRequest } from "../../src/phone-gateway.js";
import { FIXTURE_LOGIN } from "../fixtures/phone-gateway-harness.js";

/**
 * Tailscale Serve 1.102.2 `addProxyForwardedHeaders` sets X-Forwarded-Host from the
 * inbound Host, X-Forwarded-Proto to `https` when the inbound request is TLS, and
 * X-Forwarded-For to the tailnet source address. Task 34 evidence recorded those
 * header names and the tailnet addresses below; it did not capture loopback bytes.
 */
const PUBLIC_HOST = "jarvis-fixture.example.invalid:8444";
const SERVE_IPV4 = "100.87.81.57";
const SERVE_IPV6 = "fd7a:115c:a1e0::1437:513a";

function headers(extra: readonly string[] = []): readonly string[] {
  return ["Host", PUBLIC_HOST, "Tailscale-User-Login", FIXTURE_LOGIN, ...extra];
}

function serveSet(client: string, host = PUBLIC_HOST, proto = "https"): readonly string[] {
  return headers([
    "X-Forwarded-For", client,
    "X-Forwarded-Host", host,
    "X-Forwarded-Proto", proto,
  ]);
}

describe("exact Tailscale Serve forwarding headers", () => {
  it.each([
    ["ipv4 tailnet client", SERVE_IPV4],
    ["ipv6 tailnet client", SERVE_IPV6],
    ["cgnat range start", "100.64.0.0"],
    ["cgnat range end", "100.127.255.255"],
  ])("accepts one Serve header set for %s when the peer is loopback", (_name, client) => {
    expect(isTrustedServeRequest({ socket: { remoteAddress: "127.0.0.1" }, rawHeaders: serveSet(client) }, PUBLIC_HOST))
      .toEqual({ ok: true, login: FIXTURE_LOGIN });
  });

  it.each([
    ["client outside tailnet", serveSet("8.8.8.8")],
    ["loopback client address", serveSet("127.0.0.1")],
    ["cgnat just below range", serveSet("100.63.255.255")],
    ["cgnat just above range", serveSet("100.128.0.0")],
    ["ula outside tailnet /48", serveSet("fd7a:115c:a1e1::1")],
    ["ipv4-mapped cgnat", serveSet("::ffff:100.64.0.1")],
    ["comma-separated client list", serveSet("100.87.81.57, 8.8.8.8")],
    ["wrong forwarded host", serveSet(SERVE_IPV4, "evil.example:8444")],
    ["http proto", serveSet(SERVE_IPV4, PUBLIC_HOST, "http")],
    ["uppercase proto", serveSet(SERVE_IPV4, PUBLIC_HOST, "HTTPS")],
    ["duplicate forwarded for", headers([
      "X-Forwarded-For", SERVE_IPV4, "X-Forwarded-For", SERVE_IPV4,
      "X-Forwarded-Host", PUBLIC_HOST, "X-Forwarded-Proto", "https",
    ])],
    ["missing proto", headers(["X-Forwarded-For", SERVE_IPV4, "X-Forwarded-Host", PUBLIC_HOST])],
    ["extra Forwarded", [...serveSet(SERVE_IPV4), "Forwarded", "for=100.87.81.57"]],
    ["extra X-Real-IP", [...serveSet(SERVE_IPV4), "X-Real-IP", SERVE_IPV4]],
    ["extra Via", [...serveSet(SERVE_IPV4), "Via", "1.1 tailscale"]],
    ["extra Proxy-Authorization", [...serveSet(SERVE_IPV4), "Proxy-Authorization", "Basic x"]],
    ["unknown X-Forwarded-Server", [...serveSet(SERVE_IPV4), "X-Forwarded-Server", "tailscaled"]],
  ])("rejects %s", (_name, rawHeaders) => {
    expect(isTrustedServeRequest({ socket: { remoteAddress: "127.0.0.1" }, rawHeaders }, PUBLIC_HOST))
      .toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN });
  });

  it("rejects a valid Serve header set from a non-loopback peer", () => {
    expect(isTrustedServeRequest({ socket: { remoteAddress: "127.0.0.2" }, rawHeaders: serveSet(SERVE_IPV4) }, PUBLIC_HOST))
      .toEqual({ ok: false, code: PHONE_ERROR_CODES.PHONE_PROXY_REQUIRED });
  });
});
