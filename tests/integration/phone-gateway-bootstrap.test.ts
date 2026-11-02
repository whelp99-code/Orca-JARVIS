import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { createPhoneAuthorityReadAdapter } from "../../src/phone-gateway-adapter.js";
import { phoneGatewayRequestAudit } from "../../src/phone-gateway-server.js";
import { PHONE_ERROR_CODES, PHONE_UPSTREAM_FAILURE_STAGES } from "../../src/phone-gateway-protocol.js";
import { PHONE_GATEWAY_LIMITS } from "../../src/phone-gateway-protocol.js";
import { json, startFakeAuthority } from "../fixtures/phone-gateway-harness.js";

it("preserves the upstream concurrency bound when requests share bootstrap", async () => {
  const held: ServerResponse[] = [];
  let reached!: () => void;
  const atCapacity = new Promise<void>(resolve => { reached = resolve; });
  const authority = await startFakeAuthority((request, response) => {
    if (request.url !== "/api/v1/memory/status") return false;
    held.push(response);
    if (held.length === PHONE_GATEWAY_LIMITS.concurrentUpstream) reached();
    return true;
  });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: authority.origin });
  const calls = Array.from({ length: PHONE_GATEWAY_LIMITS.concurrentUpstream + 1 }, () => adapter.proxy({
    method: "GET", path: "/api/v1/memory/status", query: "", responseCap: 1024, isAuthenticated: () => true,
  }));
  try {
    expect(await calls[PHONE_GATEWAY_LIMITS.concurrentUpstream]).toEqual({ kind: "unavailable", stage: "slot_rejected" });
    await atCapacity;
    expect(held).toHaveLength(PHONE_GATEWAY_LIMITS.concurrentUpstream);
    expect(authority.captures.filter(row => row.url === "/api/v1/session")).toHaveLength(1);
    for (const response of held) json(response, 200, { schema_version: 1 });
    const results = await Promise.all(calls);
    expect(results.filter(row => row.kind === "ok")).toHaveLength(PHONE_GATEWAY_LIMITS.concurrentUpstream);
  } finally {
    for (const response of held) if (!response.writableEnded) response.destroy();
    await authority.close();
    await Promise.allSettled(calls);
  }
});
const proxy = { method: "GET" as const, path: "/api/v1/product-hub", query: "", responseCap: 1024, isAuthenticated: () => true };

it("names bootstrap failure without treating a missing token as success", async () => {
  const authority = await startFakeAuthority((request, response) => {
    if (request.url !== "/api/v1/session") return false;
    json(response, 200, { schema_version: 1 });
    return true;
  });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: authority.origin });
  try {
    expect(await adapter.proxy(proxy)).toEqual({ kind: "unavailable", stage: "bootstrap_failed" });
  } finally { await authority.close(); }
});

it("names a non-json upstream body as transport and does not turn it into ok", async () => {
  const authority = await startFakeAuthority((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/api/v1/session") {
      json(response, 200, { schema_version: 1, csrf_token: "a".repeat(32) });
      return true;
    }
    response.writeHead(200, { "content-type": "text/plain", "content-length": 4 });
    response.end("nope");
    return true;
  });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: authority.origin });
  try {
    expect(await adapter.proxy(proxy)).toEqual({ kind: "unavailable", stage: "transport_or_json" });
  } finally { await authority.close(); }
});

it("names one stale csrf 403 and lets the next call bootstrap again", async () => {
  let token = "a".repeat(32);
  let rejectedStale = false;
  const authority = await startFakeAuthority((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === "/api/v1/session") {
      json(response, 200, { schema_version: 1, csrf_token: token });
      return true;
    }
    if (request.headers["x-jarvis-csrf"] !== token || !rejectedStale) {
      rejectedStale = true;
      token = "b".repeat(32);
      json(response, 403, { schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED" } });
      return true;
    }
    json(response, 200, { schema_version: 1, resource: "product-hub" });
    return true;
  });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: authority.origin });
  try {
    expect(await adapter.proxy(proxy)).toEqual({ kind: "unavailable", stage: "upstream_403" });
    expect(await adapter.proxy(proxy)).toEqual({ kind: "ok", status: 200, body: { schema_version: 1, resource: "product-hub" } });
    expect(authority.captures.filter(row => row.url === "/api/v1/session")).toHaveLength(2);
  } finally { await authority.close(); }
});

it("keeps an upstream 500 invalid instead of a 403 stage or success", async () => {
  const authority = await startFakeAuthority((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/api/v1/session") return false;
    json(response, 500, { schema_version: 1, error: { code: "INTERNAL_ERROR" } });
    return true;
  });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: authority.origin });
  try {
    expect(await adapter.proxy(proxy)).toEqual({ kind: "invalid" });
  } finally { await authority.close(); }
});

it("records only a closed failure stage and no request material", () => {
  const record = phoneGatewayRequestAudit({
    requestId: "request-1", occurredAt: "2026-10-30T07:45:33.898Z", routeClass: "today",
    outcome: "upstream_unavailable", code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, status: 503,
    durationBucket: "lt100ms", ownerHex: null, failureStage: "upstream_403",
  });
  expect(record.failure_stage).toBe("upstream_403");
  expect(record.code).toBe(PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE);
  expect(record.status).toBe(503);
  expect(PHONE_UPSTREAM_FAILURE_STAGES).toContain(record.failure_stage);
  const wire = JSON.stringify(record);
  expect(wire).not.toContain("url");
  expect(wire).not.toContain("header");
  expect(wire).not.toContain("csrf");
  expect(wire).not.toContain("body");
});
