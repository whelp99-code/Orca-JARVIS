import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createElectronNotificationAdapter, createNotificationDeliveryClient } from "../../scripts/lib/electron-notification-client.mjs";

class FakeNotification extends EventEmitter {
  static isSupported(): boolean { return true; }
  readonly options: Readonly<Record<string, string>>;
  constructor(options: Readonly<Record<string, string>>) { super(); this.options = options; }
  show(): void { queueMicrotask(() => this.emit("show")); }
}

describe("Electron notification delivery client", () => {
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
