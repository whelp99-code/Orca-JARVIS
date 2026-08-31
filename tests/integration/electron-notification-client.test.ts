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
