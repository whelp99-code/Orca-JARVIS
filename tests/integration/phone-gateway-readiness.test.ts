import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createPhoneGatewayServer, parsePhoneGatewayConfig, PHONE_ERROR_CODES } from "../../src/phone-gateway.js";
import { json, makePhoneHome, processUid, startFakeAuthority } from "../fixtures/phone-gateway-harness.js";

const SLOW_HEALTH_MS = 6_500;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function staticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-phone-static-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  return root;
}

describe("phone gateway readiness", () => {
  it("reports ready when authority health is slow but within the shared probe budget", async () => {
    const files = makePhoneHome();
    roots.push(files.home);
    const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    const authority = await startFakeAuthority((incoming, response) => {
      const path = (incoming.url ?? "").split("?")[0];
      if (incoming.method === "GET" && path === "/api/v1/health") {
        setTimeout(() => {
          json(response, 200, { schema_version: 1, status: "ok", authority: "ready" });
        }, SLOW_HEALTH_MS);
        return true;
      }
      return false;
    });
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1",
      port: 0,
      upstream: authority.origin,
      staticRoot: staticRoot(),
      config,
    });
    try {
      const response = await request(`http://127.0.0.1:${String(gateway.address.port)}/readyz`);
      expect(response.statusCode).toBe(200);
      expect(await response.body.json()).toEqual({ schema_version: 1, status: "ok" });
      expect(authority.captures.some(entry => entry.url === "/api/v1/health")).toBe(true);
    } finally {
      gateway.close();
      await authority.close();
    }
  }, 15_000);

  it("stays not-ready when the authority health route never answers", async () => {
    const files = makePhoneHome();
    roots.push(files.home);
    const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    const authority = await startFakeAuthority((incoming, response) => {
      const path = (incoming.url ?? "").split("?")[0];
      if (incoming.method === "GET" && path === "/api/v1/health") {
        response.destroy();
        return true;
      }
      return false;
    });
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1",
      port: 0,
      upstream: authority.origin,
      staticRoot: staticRoot(),
      config,
    });
    try {
      const response = await request(`http://127.0.0.1:${String(gateway.address.port)}/readyz`);
      expect(response.statusCode).toBe(503);
      const body = await response.body.json() as { error: { code: string } };
      expect(body.error.code).toBe(PHONE_ERROR_CODES.PHONE_NOT_READY);
    } finally {
      gateway.close();
      await authority.close();
    }
  });
});
