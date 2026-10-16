import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthorityDb } from "../db.js";
import { parseNotificationClaimInput, parseNotificationSettleInput } from "../notification-delivery-input.js";
import { NotificationDeliveryStore } from "../notification-delivery-store.js";
import { NotificationDeliveryError } from "../notification-delivery-types.js";
import type { ReconcileHub } from "./events.js";
import { writeDashboardJson } from "./http.js";
import type { DashboardSessionStore } from "./session.js";

export type NotificationPublisher = { publishPersonal(kind: "notification"): void };
type Input = { readonly db: AuthorityDb; readonly path: string; readonly body: unknown; readonly request: IncomingMessage; readonly response: ServerResponse;
  readonly requestId: string; readonly hub: ReconcileHub; readonly session: DashboardSessionStore; readonly clock: () => Date };
type Route = { readonly kind: "claim" } | { readonly kind: "settle"; readonly deliveryId: string }
  | { readonly kind: "invalid" } | { readonly kind: "unhandled" };
const ERROR_STATUS = {
  NOTIFICATION_DELIVERY_INVALID: 400, NOTIFICATION_DELIVERY_NOT_FOUND: 404,
  NOTIFICATION_DELIVERY_REPLAY_CONFLICT: 409, NOTIFICATION_DELIVERY_STALE_LEASE: 409,
  NOTIFICATION_DELIVERY_EXPIRED: 410, NOTIFICATION_DELIVERY_UNAVAILABLE: 503,
} as const;

export function tryHandleNotificationDelivery(input: Input): boolean {
  const route = match(input.path);
  switch (route.kind) {
    case "unhandled": return false;
    case "invalid": writeError(input, new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID")); return true;
    case "claim": return claim(input);
    case "settle": return settle(input, route.deliveryId);
    default: return assertNever(route);
  }
}
function claim(input: Input): boolean {
  try {
    parseNotificationClaimInput(input.body);
    const result = store(input).claimEffect(now(input), input.session.authenticatedSessionId(), supportsCompanyReport(input.request));
    publishNotificationMutation(input.hub, result.changed);
    if (result.value === null) {
      input.response.statusCode = 204; input.response.setHeader("Cache-Control", "no-store");
      input.response.setHeader("X-Request-Id", input.requestId); input.response.end(); return true;
    }
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: result.value });
    return true;
  } catch (error) { if (error instanceof NotificationDeliveryError) { writeError(input, error); return true; } throw error; }
}
function settle(input: Input, deliveryId: string): boolean {
  try {
    const body = parseNotificationSettleInput(input.body);
    const result = store(input).settleEffect({ deliveryId, input: body, now: now(input),
      sessionId: input.session.authenticatedSessionId() });
    publishNotificationMutation(input.hub, result.changed);
    writeDashboardJson(input.response, { status: result.value.state === "expired" ? 410 : 200,
      requestId: input.requestId, body: result.value });
    return true;
  } catch (error) { if (error instanceof NotificationDeliveryError) { writeError(input, error); return true; } throw error; }
}
export function publishNotificationMutation(hub: NotificationPublisher, changed: boolean): void {
  if (changed) hub.publishPersonal("notification");
}
function store(input: Input): NotificationDeliveryStore {
  return new NotificationDeliveryStore({ authority: input.db, resourceIsCurrent: (link, instant) => resourceCurrent(input.db, link, instant) });
}
function supportsCompanyReport(request: IncomingMessage): boolean {
  const raw = request.headers["x-jarvis-notification-types"];
  const value = Array.isArray(raw) ? raw.join(",") : raw ?? "";
  return value.split(",").some(item => item.trim() === "company-daily-report");
}
function resourceCurrent(db: AuthorityDb, link: string, nowValue: string): boolean {
  const company = /^\/approvals\/company-reports\/([^/?]+)$/u.exec(link);
  if (company?.[1] !== undefined) {
    let reportId: string;
    try { reportId = decodeURIComponent(company[1]); }
    catch (error) { if (error instanceof URIError) return false; throw error; }
    return db.db.prepare("SELECT 1 AS ok FROM company_daily_reports WHERE report_id=?").get(reportId) !== undefined;
  }
  const matched = /^\/recommendations\/([^/?]+)\?rank=([1-9]|[12]\d|3[0-2])$/u.exec(link);
  const encoded = matched?.[1]; const rawRank = matched?.[2];
  if (encoded === undefined || rawRank === undefined) return false;
  let recommendationId: string;
  try { recommendationId = decodeURIComponent(encoded); }
  catch (error) { if (error instanceof URIError) return false; throw error; }
  const row = db.db.prepare(
    `SELECT r.lifecycle_state,r.expires_at,
      COALESCE((SELECT e.state FROM personal_recommendation_action_events e
        WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank ORDER BY e.event_sequence DESC LIMIT 1),a.initial_state) AS state
     FROM personal_recommendations r JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
     WHERE r.recommendation_id=? AND a.rank=?`,
  ).get(recommendationId, Number(rawRank));
  if (typeof row !== "object" || row === null) return false;
  const lifecycle = Reflect.get(row, "lifecycle_state"); const expires = Reflect.get(row, "expires_at");
  return Reflect.get(row, "state") === "pending" && typeof expires === "string" && nowValue < expires
    && (lifecycle === "eligible" || lifecycle === "presented" || lifecycle === "selected");
}
function now(input: Input): string {
  const value = input.clock();
  if (Object.getPrototypeOf(value) !== Date.prototype || !Number.isFinite(value.getTime())) {
    throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
  }
  return value.toISOString();
}
function match(path: string): Route {
  if (path === "/api/v1/notification-deliveries/claim") return { kind: "claim" };
  const prefix = "/api/v1/notification-deliveries/"; const suffix = "/settle";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return { kind: "unhandled" };
  const id = path.slice(prefix.length, -suffix.length);
  return /^ndl:pos:v1:[0-9a-f]{64}$/u.test(id) ? { kind: "settle", deliveryId: id } : { kind: "invalid" };
}
function writeError(input: Input, error: NotificationDeliveryError): void {
  writeDashboardJson(input.response, { status: ERROR_STATUS[error.code], requestId: input.requestId,
    body: { schema_version: 1, error: { code: error.code, message: "Notification delivery unavailable", request_id: input.requestId } } });
}
function assertNever(value: never): never {
  void value;
  throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
}
