import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { createPhoneAuthorityReadAdapter } from "../../src/phone-gateway-adapter.js";
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
    expect(await calls[PHONE_GATEWAY_LIMITS.concurrentUpstream]).toEqual({ kind: "unavailable" });
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
