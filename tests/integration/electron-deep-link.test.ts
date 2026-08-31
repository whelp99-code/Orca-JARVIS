import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createDeepLinkCoordinator, encodeRecommendationDeepLink } from "../../scripts/lib/electron-deep-link.mjs";

const ID = "rec:pos:v1:integration-one";
describe("Electron deep-link instance integration", () => {
  it("resolves first and second opens through real HTTP and falls back after deletion", async () => {
    // Given
    let available = true; let reads = 0; const events = new EventEmitter(); const routes: string[] = []; let focuses = 0;
    const server = createServer((_request, response) => { reads += 1; response.setHeader("Content-Type", "application/json");
      if (!available) { response.statusCode = 404; response.end("{}"); return; }
      response.end(JSON.stringify({ schema_version: 1, resource: "recommendation", recommendation_id: ID,
        context_id: "ctx:pos:v1:integration", canonical_digest: "sha256:" + "1".repeat(64),
        evidence_digest: "sha256:" + "2".repeat(64), approval_requirement: "owner", confidence_class: "high",
        lifecycle_state: "eligible", expires_at: "2026-08-28T13:00:00.000Z", state: "ready",
        actions: [{ rank: 2, title: "Review", operation: "review", target_digest: "sha256:" + "3".repeat(64),
          state: "pending", owner_decision_required: true, current: true, occurred_at: null, transition_digest: null }],
        evidence: [], conflicts: [], omissions: [], deep_links: { context_evidence: "/api/v1/contexts/x/evidence" } })); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new TypeError("address required");
    const coordinator = createDeepLinkCoordinator({ authorityUrl: `http://127.0.0.1:${address.port}`,
      request: async url => await fetch(url), focus: () => { focuses += 1; }, navigate: route => { routes.push(route); events.emit("navigate"); },
      onError: code => { events.emit("error-code", code); } });
    const link = encodeRecommendationDeepLink(ID, 2);
    try {
      // When: subscribe before each first/second/deleted trigger.
      const first = once(events, "navigate"); void coordinator.open(link); await first;
      const second = once(events, "navigate"); void coordinator.open(link); await second;
      available = false; const deleted = once(events, "navigate"); void coordinator.open(link); await deleted;
      // Then
      expect(routes).toEqual([`/recommendations/${encodeURIComponent(ID)}?rank=2`,
        `/recommendations/${encodeURIComponent(ID)}?rank=2`, "/"]);
      expect(focuses).toBe(3); expect(reads).toBe(3);
    } finally { server.closeAllConnections(); server.close(); }
  });

  it("rejects malformed instance input without focus, navigation, or HTTP", async () => {
    // Given
    const errors: string[] = []; let effects = 0;
    const coordinator = createDeepLinkCoordinator({ authorityUrl: "http://127.0.0.1:1", request: async () => { effects += 1; throw new TypeError(); },
      focus: () => { effects += 1; }, navigate: () => { effects += 1; }, onError: code => { errors.push(code); } });
    // When
    await coordinator.open("jarvis://evil/today");
    // Then
    expect(errors).toEqual(["ELECTRON_DEEP_LINK_INVALID"]); expect(effects).toBe(0);
  });
});
