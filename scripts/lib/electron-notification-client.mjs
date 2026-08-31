export class ElectronNotificationError extends Error {
  constructor(code) { super(code); this.name = "ElectronNotificationError"; this.code = code; }
}
function failure(error) {
  return error instanceof ElectronNotificationError && ["NOTIFICATIONS_UNSUPPORTED", "NOTIFICATIONS_DENIED"].includes(error.code)
    ? error.code : "NOTIFICATION_SHOW_FAILED";
}
export function createElectronNotificationAdapter(NotificationType, onClick) {
  return {
    isSupported: () => NotificationType.isSupported(),
    show: ({ payload, signal }) => new Promise((resolve, reject) => {
      if (!NotificationType.isSupported()) { reject(new ElectronNotificationError("NOTIFICATIONS_UNSUPPORTED")); return; }
      const notification = new NotificationType({ title: payload.title, body: payload.summary });
      let settled = false;
      const finish = (action, value) => { if (settled) return; settled = true; signal.removeEventListener("abort", aborted); action(value); };
      const aborted = () => finish(reject, new ElectronNotificationError("NOTIFICATION_SHOW_FAILED"));
      notification.once("show", () => finish(resolve, "shown"));
      notification.once("click", () => { onClick(payload.deep_link); });
      notification.once("failed", () => finish(reject, new ElectronNotificationError("NOTIFICATION_SHOW_FAILED")));
      notification.once("close", () => finish(reject, new ElectronNotificationError("NOTIFICATION_SHOW_FAILED")));
      signal.addEventListener("abort", aborted, { once: true });
      notification.show();
    }),
  };
}
export function createNotificationDeliveryClient({ transport, adapter, onError }) {
  let active = false; let dirty = false; let closed = false;
  const drain = async () => {
    if (active || closed) { dirty = true; return; }
    active = true;
    try {
      do {
        dirty = false;
        for (;;) {
          const claim = await transport.claim();
          if (claim === null) break;
          const controller = new AbortController();
          try {
            await adapter.show({ deliveryId: claim.delivery_id, payload: claim.payload, signal: controller.signal });
            await transport.settle(claim.delivery_id, { schema_version: 1, outcome: "delivered" });
          } catch (error) {
            await transport.settle(claim.delivery_id, { schema_version: 1, outcome: "failed", failure_code: failure(error) });
          } finally { controller.abort(); }
        }
      } while (dirty && !closed);
    } catch (error) { onError(error); } finally { active = false; }
  };
  return {
    start: async () => { const subscription = transport.subscribe(() => { void drain(); }); await subscription.ready; await drain(); },
    close: () => { closed = true; transport.close(); },
  };
}
