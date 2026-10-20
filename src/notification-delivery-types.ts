export const NOTIFICATION_DELIVERY_ERROR_CODES = [
  "NOTIFICATION_DELIVERY_INVALID", "NOTIFICATION_DELIVERY_NOT_FOUND", "NOTIFICATION_DELIVERY_REPLAY_CONFLICT",
  "NOTIFICATION_DELIVERY_STALE_LEASE", "NOTIFICATION_DELIVERY_EXPIRED", "NOTIFICATION_DELIVERY_UNAVAILABLE",
] as const;
export type NotificationDeliveryErrorCode = (typeof NOTIFICATION_DELIVERY_ERROR_CODES)[number];
export const NOTIFICATION_FAILURE_CODES = [
  "NOTIFICATIONS_UNSUPPORTED", "NOTIFICATIONS_DENIED", "NOTIFICATION_SHOW_FAILED",
] as const;
export type NotificationFailureCode = (typeof NOTIFICATION_FAILURE_CODES)[number];
export class NotificationDeliveryError extends Error {
  readonly name = "NotificationDeliveryError";
  constructor(readonly code: NotificationDeliveryErrorCode) { super(code); }
}
export type NotificationClaimInput = { readonly schema_version: 1 };
export type NotificationSettleInput =
  | { readonly schema_version: 1; readonly outcome: "delivered" }
  | { readonly schema_version: 1; readonly outcome: "failed"; readonly failure_code: NotificationFailureCode };
export type MacNotificationPayload = {
  readonly title: "Decision needed" | "Critical decision needed" | "Decision digest" | "Company daily report";
  readonly summary: string;
  readonly alert_class: "decision_action" | "decision_critical" | "decision_digest" | "company_daily_report";
  readonly deep_link: string;
};
export type NotificationClaim = {
  readonly schema_version: 1; readonly delivery_id: string; readonly intent_id: string; readonly expires_at: string;
  readonly payload: MacNotificationPayload;
};
export type NotificationSettlement = {
  readonly schema_version: 1; readonly delivery_id: string; readonly intent_id: string;
  readonly state: "delivered" | "failed" | "expired"; readonly settled_at: string;
};
