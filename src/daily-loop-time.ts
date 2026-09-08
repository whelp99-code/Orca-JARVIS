import { createHash } from "node:crypto";
import {
	parseDailyLoopDate,
	parseDailyLoopEvent,
	parseDailyLoopFreshness,
	parseDailyLoopIdentity,
	parseDailyLoopInstant,
	parseDailyLoopPhase,
	parseRefreshCompletion,
} from "./daily-loop-input.js";
import { DailyLoopError, type DailyLoopCalendarDecision, type DailyLoopPhase, type RefreshContext } from "./daily-loop-types.js";

export const KST_OFFSET_MS = 32_400_000;
const pad = (value: number): string => String(value).padStart(2, "0");
const localParts = (
	instant: Date,
): {
	readonly date: string;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
} => {
	const local = new Date(instant.getTime() + KST_OFFSET_MS);
	return {
		date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
		hour: local.getUTCHours(),
		minute: local.getUTCMinutes(),
		second: local.getUTCSeconds(),
		millisecond: local.getUTCMilliseconds(),
	};
};
export const kstInstant = (date: string, hour: number, minute: number): Date => {
	const parsed = parseDailyLoopDate(date);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
		throw new DailyLoopError("DAILY_LOOP_DATE_INVALID");
	const [yearText, monthText, dayText] = parsed.split("-");
	const result = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), hour, minute) - KST_OFFSET_MS);
	const roundTrip = localParts(result);
	if (roundTrip.date !== parsed || roundTrip.hour !== hour || roundTrip.minute !== minute || roundTrip.second !== 0 || roundTrip.millisecond !== 0)
		throw new DailyLoopError("DAILY_LOOP_DATE_INVALID");
	return result;
};
const offsetDate = (date: string, delta: number): string =>
	new Date(Date.parse(`${parseDailyLoopDate(date)}T00:00:00.000Z`) + delta).toISOString().slice(0, 10);
const nextDate = (date: string): string => offsetDate(date, 86_400_000);
export const previousKstDate = (date: string): string => offsetDate(date, -86_400_000);
const boundedIdentity = (identity: string): string => {
	const safe = identity.replace(/[^A-Za-z0-9_-]/g, "_");
	return safe.length <= 48 ? safe : `sha256_${createHash("sha256").update(identity).digest("hex")}`;
};
export function legacyDailyLoopKey(dateValue: unknown, phaseValue: unknown, eventIdentity?: unknown): string {
	const date = parseDailyLoopDate(dateValue);
	const phase: DailyLoopPhase = parseDailyLoopPhase(phaseValue);
	if ((phase === "in_day") === (eventIdentity === undefined)) throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
	const suffix = eventIdentity === undefined ? "scheduled" : `event:${boundedIdentity(parseDailyLoopIdentity(eventIdentity))}`;
	return `daily:${date}:${phase}:${suffix}`;
}
/** Current keys retain the raw event identity; legacy keys are only for stored replay. */
export function canonicalDailyLoopKey(dateValue: unknown, phaseValue: unknown, eventIdentity?: unknown): string {
  const legacy = legacyDailyLoopKey(dateValue, phaseValue, eventIdentity);
  if (phaseValue !== "in_day") return legacy;
  const hash = createHash("sha256").update("orca-jarvis/daily-event/v2\0")
    .update(JSON.stringify(parseDailyLoopIdentity(eventIdentity)), "utf8").digest("hex");
  return `daily:${parseDailyLoopDate(dateValue)}:in_day:event:v2:${hash}`;
}
export function classifyDailyLoopInstant(instantValue: unknown, inputValue: unknown): DailyLoopCalendarDecision {
	const instant = parseDailyLoopInstant(instantValue);
	const input = parseDailyLoopEvent(inputValue);
	const eventInstant = input.kind === "event" ? new Date(input.occurred_at) : instant;
	const local = localParts(eventInstant);
	if (input.kind === "scheduled") {
		if (local.hour === 7 && local.minute === 15 && local.second === 0 && local.millisecond === 0)
			return {
				kind: "due",
				local_date: local.date,
				phase: "morning",
				scheduled_at: instant.toISOString(),
			};
		if (local.hour === 21 && local.minute === 30 && local.second === 0 && local.millisecond === 0)
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
		scheduled_at: eventInstant.toISOString(),
		event_id: input.event_id,
		occurred_at: input.occurred_at,
		critical: input.critical,
		...(input.critical ? { critical_reason: input.critical_reason } : {}),
		event_cost: { items: input.items, work: input.work, bytes: input.bytes },
		...(quiet ? { bypass_reason: "critical_quiet_hours_bypass" as const } : {}),
	};
}
export function evaluateRefreshContext(refreshValue: unknown, atValue: unknown, freshnessValue: unknown): RefreshContext {
	const at = parseDailyLoopInstant(atValue);
	const freshnessMs = parseDailyLoopFreshness(freshnessValue);
	let refresh;
	try {
		refresh = parseRefreshCompletion(refreshValue);
	} catch (error) {
		if (error instanceof DailyLoopError && error.code === "DAILY_LOOP_REFRESH_INVALID")
			return { state: "degraded", reason: "refresh_invalid", refresh_id: null };
		throw error;
	}
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
	if (completed > at.getTime() || at.getTime() - completed > freshnessMs)
		return {
			state: "degraded",
			reason: "refresh_stale",
			refresh_id: refresh.refresh_id,
		};
	return {
		state: "ready",
		reason: "refresh_fresh",
		refresh_id: refresh.refresh_id,
	};
}
export const kstLocalDate = (instant: unknown): string => localParts(parseDailyLoopInstant(instant)).date;
