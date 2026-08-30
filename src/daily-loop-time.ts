import { createHash } from "node:crypto";
import type { DailyLoopCalendarDecision, DailyLoopInput, DailyLoopPhase, RefreshCompletion, RefreshContext } from "./daily-loop-types.js";

const KST_OFFSET_MS = 9 * 60 * 60_000;
const pad = (value: number): string => String(value).padStart(2, "0");
const localParts = (
  instant: Date,
): {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
} => {
  const local = new Date(instant.getTime() + KST_OFFSET_MS);
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
};
export const kstInstant = (date: string, hour: number, minute: number): Date => {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute));
};
const nextDate = (date: string): string => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};
const boundedIdentity = (identity: string): string => {
  const safe = identity.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length <= 48 ? safe : `sha256_${createHash("sha256").update(identity).digest("hex")}`;
};
export function canonicalDailyLoopKey(date: string, phase: DailyLoopPhase, eventIdentity?: string): string {
  const suffix = eventIdentity === undefined ? "scheduled" : `event:${boundedIdentity(eventIdentity)}`;
  return `daily:${date}:${phase}:${suffix}`;
}
export function classifyDailyLoopInstant(instant: Date, input: DailyLoopInput): DailyLoopCalendarDecision {
  const local = localParts(instant);
  if (input.kind === "scheduled") {
    if (local.hour === 7 && local.minute === 15)
      return {
        kind: "due",
        local_date: local.date,
        phase: "morning",
        scheduled_at: instant.toISOString(),
      };
    if (local.hour === 21 && local.minute === 30)
      return {
        kind: "due",
        local_date: local.date,
        phase: "evening",
        scheduled_at: instant.toISOString(),
      };
    return { kind: "not_due" };
  }
  const quiet = local.hour >= 22 || local.hour < 7;
  if (quiet && !input.critical) {
    const allowedDate = local.hour >= 22 ? nextDate(local.date) : local.date;
    return {
      kind: "deferred",
      next_allowed_at: kstInstant(allowedDate, 7, 0).toISOString(),
      deferred_key: canonicalDailyLoopKey(allowedDate, "in_day", input.event_id),
    };
  }
  return {
    kind: "due",
    local_date: local.date,
    phase: "in_day",
    scheduled_at: instant.toISOString(),
    event_id: input.event_id,
    event_cost: { items: input.items, work: input.work, bytes: input.bytes },
    ...(quiet ? { bypass_reason: "critical_quiet_hours_bypass" as const } : {}),
  };
}
export function evaluateRefreshContext(refresh: RefreshCompletion | null, at: Date, freshnessMs: number): RefreshContext {
  if (refresh === null) return { state: "no_data", reason: "refresh_missing", refresh_id: null };
  if (refresh.state === "failed")
    return {
      state: "degraded",
      reason: "refresh_failed",
      refresh_id: refresh.refresh_id,
    };
  if (refresh.protocol_version !== 1)
    return {
      state: "degraded",
      reason: "refresh_incompatible",
      refresh_id: refresh.refresh_id,
    };
  if (refresh.capped)
    return {
      state: "degraded",
      reason: "refresh_capped",
      refresh_id: refresh.refresh_id,
    };
  const completed = Date.parse(refresh.completed_at);
  if (!Number.isFinite(completed) || completed > at.getTime() || at.getTime() - completed > freshnessMs) {
    return {
      state: "degraded",
      reason: "refresh_stale",
      refresh_id: refresh.refresh_id,
    };
  }
  return {
    state: "ready",
    reason: "refresh_fresh",
    refresh_id: refresh.refresh_id,
  };
}
export const kstLocalDate = (instant: Date): string => localParts(instant).date;
