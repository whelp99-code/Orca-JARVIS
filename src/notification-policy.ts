import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { NotificationPolicyDecision, OwnerDecisionQueueEntry } from "./notification-intent-types.js";

export const NOTIFICATION_DEBOUNCE_MS = 15 * 60_000;
export const NOTIFICATION_CRITICAL_WINDOW_MS = 60 * 60_000;
export type PriorNotificationIntent = { readonly created_at: string; readonly state: string };
const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
function kstHour(epoch: number): number { return new Date(epoch + 9 * 60 * 60_000).getUTCHours(); }
function nextAllowed(epoch: number): string {
  const local = new Date(epoch + 9 * 60 * 60_000); const hour = local.getUTCHours();
  const dayOffset = hour >= 22 ? 1 : 0;
  const localSeven = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, 7);
  return new Date(localSeven - 9 * 60 * 60_000).toISOString();
}
function criticalReason(entry: OwnerDecisionQueueEntry, epoch: number): string | null {
  if (entry.safety === "critical") return "critical_owner_safety";
  if (entry.deadline !== null && Date.parse(entry.deadline) - epoch <= NOTIFICATION_CRITICAL_WINDOW_MS) {
    return "critical_owner_deadline";
  }
  return null;
}
export function deriveNotificationDecision(entry: OwnerDecisionQueueEntry | undefined, clock: string,
  prior: PriorNotificationIntent | null): NotificationPolicyDecision {
  if (entry === undefined) return { urgency: "silent", state: "suppressed", reason: "no_active_owner_decision",
    not_before: null, intent_id: null };
  const epoch = Date.parse(clock); const intentId = `ntf:pos:v1:${hash({ dedup_key: entry.dedup_key, semantic: entry.semantic_digest })}`;
  if (epoch >= Date.parse(entry.expires_at)) return { urgency: "silent", state: "suppressed", reason: "decision_expired",
    not_before: null, intent_id: null };
  if (prior !== null && epoch - Date.parse(prior.created_at) < NOTIFICATION_DEBOUNCE_MS) {
    return { urgency: "silent", state: "suppressed", reason: "notification_debounce", not_before: null, intent_id: null };
  }
  const critical = criticalReason(entry, epoch); const hour = kstHour(epoch); const quiet = hour >= 22 || hour < 7;
  if (critical !== null) return { urgency: "critical", state: "queued",
    reason: quiet ? "critical_quiet_hours_bypass" : critical, not_before: clock, intent_id: intentId };
  if (quiet) {
    const allowed = nextAllowed(epoch);
    if (allowed >= entry.expires_at) return { urgency: "silent", state: "suppressed", reason: "decision_expires_in_quiet_hours",
      not_before: null, intent_id: null };
    return { urgency: "digest", state: "deferred", reason: "noncritical_quiet_hours_deferred",
      not_before: allowed, intent_id: intentId };
  }
  if (entry.deadline !== null) return { urgency: "action", state: "queued", reason: "owner_decision_due",
    not_before: clock, intent_id: intentId };
  return { urgency: "digest", state: "queued", reason: "owner_decision_digest", not_before: clock, intent_id: intentId };
}
