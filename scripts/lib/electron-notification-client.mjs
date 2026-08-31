import { parseJarvisDeepLink } from "./electron-deep-link.mjs";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9]\d*$/u;
const DELIVERY = /^ndl:pos:v1:[0-9a-f]{64}$/u;
const TOPICS = new Set(["overview", "tasks", "agents", "approvals", "personal.today.v1", "personal.recommendations.v1",
  "personal.context-evidence.v1", "personal.daily-runs.v1", "personal.decision-inbox.v1",
  "personal.notification-intents.v1", "personal.source-health.v1"]);
export class ElectronProtocolError extends Error {
  constructor() { super("ELECTRON_PROTOCOL_INVALID"); this.name = "ElectronProtocolError"; this.code = "ELECTRON_PROTOCOL_INVALID"; }
}
function protocolInvalid() { throw new ElectronProtocolError(); }
function exact(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return protocolInvalid();
  }
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) return protocolInvalid();
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !TIME.test(value) || !Number.isFinite(Date.parse(value))) return protocolInvalid();
  return value;
}
function identifier(value, delivery = false) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256
    || (delivery && !DELIVERY.test(value))) return protocolInvalid();
  return value;
}
export function parseSessionResponse(value) {
  const row = exact(value, ["schema_version", "csrf_token"]);
  if (row.schema_version !== 1 || typeof row.csrf_token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(row.csrf_token)) {
    return protocolInvalid();
  }
  return { schema_version: 1, csrf_token: row.csrf_token };
}
function parsePayload(value) {
  const row = exact(value, ["title", "summary", "alert_class", "deep_link"]);
  if (!["Decision needed", "Critical decision needed", "Decision digest"].includes(row.title)
    || typeof row.summary !== "string" || row.summary.length === 0 || Buffer.byteLength(row.summary, "utf8") > 160
    || !["decision_action", "decision_critical", "decision_digest"].includes(row.alert_class)
    || typeof row.deep_link !== "string") return protocolInvalid();
  parseJarvisDeepLink(row.deep_link);
  return { title: row.title, summary: row.summary, alert_class: row.alert_class, deep_link: row.deep_link };
}
export function parseClaimResponse(status, value) {
  if (status === 204) { if (value !== undefined && value !== null) return protocolInvalid(); return null; }
  if (status !== 200) return protocolInvalid();
  const row = exact(value, ["schema_version", "delivery_id", "intent_id", "expires_at", "payload"]);
  if (row.schema_version !== 1) return protocolInvalid();
  return { schema_version: 1, delivery_id: identifier(row.delivery_id, true), intent_id: identifier(row.intent_id),
    expires_at: timestamp(row.expires_at), payload: parsePayload(row.payload) };
}
export function parseSettlementResponse(status, value) {
  if (status !== 200 && status !== 410) return protocolInvalid();
  const row = exact(value, ["schema_version", "delivery_id", "intent_id", "state", "settled_at"]);
  if (row.schema_version !== 1 || !["delivered", "failed", "expired"].includes(row.state)
    || (status === 410) !== (row.state === "expired")) return protocolInvalid();
  return { schema_version: 1, delivery_id: identifier(row.delivery_id, true), intent_id: identifier(row.intent_id),
    state: row.state, settled_at: timestamp(row.settled_at) };
}
export function parseSseFrame(frame) {
  if (typeof frame !== "string" || Buffer.byteLength(frame, "utf8") > 16_384) return protocolInvalid();
  if (frame === ":") return { id: null, type: "heartbeat", notification: false };
  const lines = frame.split("\n");
  if (lines.length !== 3 || !lines[0].startsWith("id: ") || !lines[1].startsWith("event: ") || !lines[2].startsWith("data: ")) {
    return protocolInvalid();
  }
  const id = lines[0].slice(4); const eventType = lines[1].slice(7);
  if (!REVISION.test(id) || (eventType !== "snapshot" && eventType !== "reconcile")) return protocolInvalid();
  let value;
  try { value = JSON.parse(lines[2].slice(6)); } catch (error) { if (error instanceof SyntaxError) return protocolInvalid(); throw error; }
  const row = exact(value, ["schema_version", "type", "revision", "topics", "occurred_at"]);
  if (row.schema_version !== 1 || row.type !== eventType || row.revision !== id || !Array.isArray(row.topics)
    || row.topics.length > 32 || row.topics.some(topic => typeof topic !== "string" || !TOPICS.has(topic))
    || new Set(row.topics).size !== row.topics.length) return protocolInvalid();
  timestamp(row.occurred_at);
  return { id, type: eventType, notification: row.topics.includes("personal.notification-intents.v1") };
}

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
  let active = false; let dirty = false; let closed = false; let ready = false; let drained = false;
  const drain = async () => {
    if (closed) return;
    if (active) { if (drained) dirty = true; return; }
    active = true; drained = false;
    try {
      do {
        dirty = false;
        for (;;) {
          const claim = await transport.claim();
          if (claim === null) { drained = true; break; }
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
    start: async () => {
      const subscription = transport.subscribe(() => { if (ready) void drain(); });
      await subscription.ready; ready = true; await drain();
    },
    close: () => { closed = true; transport.close(); },
  };
}
