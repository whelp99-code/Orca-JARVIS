import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createElectronNotificationAdapter, createNotificationDeliveryClient, parseClaimResponse, parseSessionResponse,
  parseSettlementResponse, parseSseFrame } from "../../scripts/lib/electron-notification-client.mjs";

class FakeNotification extends EventEmitter {
  static isSupported(): boolean { return true; }
  readonly options: Readonly<Record<string, string>>;
  constructor(options: Readonly<Record<string, string>>) { super(); this.options = options; }
  show(): void { queueMicrotask(() => this.emit("show")); }
}

describe("Electron notification delivery client", () => {
  it("coalesces a synchronous subscription snapshot into exactly one drain", async () => {
    // Given
    let listener: (() => void) | undefined; let claims = 0; let shows = 0; let releaseFirst: (() => void) | undefined;
    let signalFirst: (() => void) | undefined; const firstStarted = new Promise<void>(resolve => { signalFirst = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const transport = {
      subscribe: (value: () => void) => { listener = value; value(); return { ready: Promise.resolve() }; },
      claim: async () => { claims += 1; if (claims === 1) { signalFirst?.(); await firstGate; }
        return claims === 1 ? { delivery_id: "delivery",
          payload: { title: "Decision needed", summary: "Review decision", alert_class: "decision_action",
            deep_link: "jarvis://open/today" } } : null; },
      settle: async () => undefined,
      close: () => undefined,
    };
    const adapter = { isSupported: () => true, show: async () => { shows += 1; return "shown"; } };
    const client = createNotificationDeliveryClient({ transport, adapter, onError: (error: unknown) => { throw error; } });
    // When
    const started = client.start(); await firstStarted; releaseFirst?.(); await started;
    // Then
    expect(listener).toBeDefined(); expect(claims).toBe(2); expect(shows).toBe(1); client.close();
  });

  it("rejects malformed SSE and HTTP authority responses before effects", () => {
    // Given
    const validPayload = { title: "Decision needed", summary: "Review decision", alert_class: "decision_action",
      deep_link: "jarvis://open/today" };
    const malformed = [null, {}, { schema_version: 1, csrf_token: "short" }, { schema_version: 1, extra: true }];
    // When / Then
    for (const value of malformed) expect(() => parseSessionResponse(value))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_PROTOCOL_INVALID" }));
    expect(() => parseClaimResponse(200, { schema_version: 1, delivery_id: "bad", intent_id: "bad",
      expires_at: "bad", payload: validPayload }))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_PROTOCOL_INVALID" }));
    expect(() => parseSettlementResponse(200, { schema_version: 1, delivery_id: "bad", intent_id: "bad",
      state: "delivered", settled_at: "bad" }))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_PROTOCOL_INVALID" }));
    expect(() => parseSseFrame("id: bad\nevent: snapshot\ndata: {}" ))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_PROTOCOL_INVALID" }));
  });

  it("allows no adapter or settlement effect from malformed authority data", async () => {
    // Given
    let adapterEffects = 0; let settles = 0; const errors: string[] = [];
    const transport = { subscribe: () => ({ ready: Promise.resolve() }),
      claim: async () => parseClaimResponse(200, { delivery_id: "untrusted", payload: {} }),
      settle: async () => { settles += 1; }, close: () => undefined };
    const adapter = { isSupported: () => true, show: async () => { adapterEffects += 1; return "shown"; } };
    const client = createNotificationDeliveryClient({ transport, adapter,
      onError: (error: unknown) => { if (error instanceof Error) errors.push(error.message); } });
    // When
    await client.start();
    // Then
    expect(adapterEffects).toBe(0); expect(settles).toBe(0); expect(errors).toEqual(["ELECTRON_PROTOCOL_INVALID"]); client.close();
  });

  it("rejects six privacy classes at summary and decoded identity with effects zero", async () => {
    // Given
    const canaries = ["TASK33_TOKEN_CANARY_7Q2M", "TASK33_PRIVATE_NAME_CANARY_4K9P", "TASK33_COMMAND_CANARY_RM9",
      "TASK33_EXCERPT_CANARY_2VX", "/Users/fictional-owner/task33-private",
      "Authorization: Bearer TASK33_BEARER_CANARY"];
    const safeLink = "jarvis://open/recommendation?id="
      + Buffer.from("rec:pos:v1:privacy-safe", "utf8").toString("base64url") + "&rank=1";
    const effects = { show: 0, settle: 0, focus: 0, navigation: 0 }; const errors: string[] = [];
    const envelopes = canaries.flatMap(canary => [{ summary: canary, deep_link: safeLink }, { summary: "Review decision",
      deep_link: "jarvis://open/recommendation?id=" + Buffer.from(canary, "utf8").toString("base64url") + "&rank=1" }]);
    // When
    for (const values of envelopes) {
      let claimed = false;
      const transport = { subscribe: () => ({ ready: Promise.resolve() }), claim: async () => {
        if (claimed) return null; claimed = true; return parseClaimResponse(200,
          { schema_version: 1, delivery_id: "ndl:pos:v1:" + "a".repeat(64), intent_id: "ntf:pos:v1:privacy",
            expires_at: "2026-08-28T13:00:00.000Z", payload: { title: "Decision needed", alert_class: "decision_action",
              ...values } }); }, settle: async () => { effects.settle += 1; }, close: () => undefined };
      const adapter = { isSupported: () => true, show: async () => { effects.show += 1; effects.focus += 1;
        effects.navigation += 1; return "shown"; } };
      const client = createNotificationDeliveryClient({ transport, adapter,
        onError: (error: unknown) => { if (error instanceof Error) errors.push(error.message); } });
      await client.start(); client.close();
    }
    // Then
    expect(envelopes).toHaveLength(12); expect(errors).toEqual(Array(12).fill("ELECTRON_PROTOCOL_INVALID"));
    expect(effects).toEqual({ show: 0, settle: 0, focus: 0, navigation: 0 });
  });

  it("subscribes before claim, shows once, and settles after show", async () => {
    // Given
    const order: string[] = []; let claims = 0;
    const transport = {
      subscribe: () => { order.push("subscribe"); return { ready: Promise.resolve() }; },
      claim: async () => { order.push("claim"); claims += 1; return claims === 1 ? { delivery_id: "delivery",
        payload: { title: "Decision needed", summary: "Review decision", alert_class: "decision_action",
          deep_link: "jarvis://open/today" } } : null; },
      settle: async (_id: string, body: unknown) => { order.push(`settle:${String(Reflect.get(body ?? {}, "outcome"))}`); },
      close: () => undefined,
    };
    const adapter = createElectronNotificationAdapter(FakeNotification, () => undefined);
    const client = createNotificationDeliveryClient({ transport, adapter, onError: (error: unknown) => { throw error; } });
    // When
    await client.start();
    // Then
    expect(order).toEqual(["subscribe", "claim", "settle:delivered", "claim"]);
    client.close();
  });
});
