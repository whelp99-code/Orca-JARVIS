import { NOTIFICATION_FAILURE_CODES, NotificationDeliveryError, type NotificationClaimInput,
  type NotificationSettleInput } from "./notification-delivery-types.js";

function invalid(): never { throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID"); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid();
  }
  return Object.fromEntries(Object.entries(value));
}
function isFailureCode(value: string): value is (typeof NOTIFICATION_FAILURE_CODES)[number] {
  return NOTIFICATION_FAILURE_CODES.some(code => code === value);
}
function exact(row: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const own = Object.keys(row);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) invalid();
}
export function parseNotificationClaimInput(value: unknown): NotificationClaimInput {
  const row = record(value); exact(row, ["schema_version"]);
  if (row["schema_version"] !== 1) return invalid();
  return { schema_version: 1 };
}
export function parseNotificationSettleInput(value: unknown): NotificationSettleInput {
  const row = record(value); const outcome = row["outcome"];
  if (outcome === "delivered") {
    exact(row, ["schema_version", "outcome"]);
    if (row["schema_version"] !== 1) return invalid();
    return { schema_version: 1, outcome };
  }
  if (outcome === "failed") {
    exact(row, ["schema_version", "outcome", "failure_code"]);
    const code = row["failure_code"];
    if (row["schema_version"] !== 1 || typeof code !== "string" || !isFailureCode(code)) return invalid();
    return { schema_version: 1, outcome, failure_code: code };
  }
  return invalid();
}
