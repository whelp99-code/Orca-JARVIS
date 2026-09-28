import {
	DailyLoopError,
	type DailyLoopBudgets,
	type DailyLoopEvent,
	type DailyLoopOptions,
	type RefreshCompletion,
} from "./daily-loop-types.js";
import {
	MAX_INT,
	closedRecord,
	fail,
	integer,
	openRecord,
	parseDailyLoopInstant,
	parseDailyLoopMorningLocalTime,
	text,
	timestamp,
} from "./daily-loop-input-scalars.js";

export {
	dailyLoopLocalTimeParts,
	parseDailyLoopClaim,
	parseDailyLoopDate,
	parseDailyLoopFreshness,
	parseDailyLoopIdentity,
	parseDailyLoopInstant,
	parseDailyLoopMorningLocalTime,
	parseDailyLoopPhase,
	parseDailyLoopRunId,
	parseDailyLoopUncertainReason,
} from "./daily-loop-input-scalars.js";

export function parseDailyLoopEvent(value: unknown): DailyLoopEvent | { readonly kind: "scheduled" } {
	const kindRecord = openRecord(value, "DAILY_LOOP_EVENT_INVALID");
	if (kindRecord["kind"] === "scheduled") {
		const scheduled = closedRecord(value, ["kind"], "DAILY_LOOP_EVENT_INVALID");
		if (scheduled["kind"] !== "scheduled") return fail("DAILY_LOOP_EVENT_INVALID");
		return Object.freeze({ kind: "scheduled" });
	}
	if (kindRecord["kind"] !== "event") return fail("DAILY_LOOP_EVENT_INVALID");
	const critical = kindRecord["critical"];
	const keys =
		critical === true
			? ["kind", "event_id", "occurred_at", "critical", "critical_reason", "items", "work", "bytes"]
			: ["kind", "event_id", "occurred_at", "critical", "items", "work", "bytes"];
	const input = closedRecord(value, keys, "DAILY_LOOP_EVENT_INVALID");
	if (input["critical"] !== true && input["critical"] !== false) return fail("DAILY_LOOP_EVENT_INVALID");
	const base = {
		kind: "event" as const,
		event_id: text(input["event_id"], 512, "DAILY_LOOP_EVENT_INVALID"),
		occurred_at: timestamp(input["occurred_at"], "DAILY_LOOP_EVENT_INVALID"),
		items: integer(input["items"], 0, MAX_INT, "DAILY_LOOP_EVENT_INVALID"),
		work: integer(input["work"], 0, MAX_INT, "DAILY_LOOP_EVENT_INVALID"),
		bytes: integer(input["bytes"], 0, MAX_INT, "DAILY_LOOP_EVENT_INVALID"),
	};
	return input["critical"] === true
		? Object.freeze({
				...base,
				critical: true as const,
				critical_reason: text(input["critical_reason"], 128, "DAILY_LOOP_EVENT_INVALID"),
			})
		: Object.freeze({ ...base, critical: false as const });
}

export function parseDailyLoopEvents(value: unknown): readonly DailyLoopEvent[] {
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("DAILY_LOOP_EVENT_INVALID");
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || !keys.includes("length")) return fail("DAILY_LOOP_EVENT_INVALID");
		const result: DailyLoopEvent[] = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable || !("value" in descriptor))
				return fail("DAILY_LOOP_EVENT_INVALID");
			const event = parseDailyLoopEvent(descriptor.value);
			if (event.kind !== "event") return fail("DAILY_LOOP_EVENT_INVALID");
			result.push(event);
		}
		return Object.freeze(result);
	} catch (error) {
		// no-excuse-ok: catch -- hostile array boundary
		if (error instanceof DailyLoopError) throw error;
		return fail("DAILY_LOOP_EVENT_INVALID");
	}
}

export function parseRefreshCompletion(value: unknown): RefreshCompletion | null {
	if (value === null) return null;
	const input = closedRecord(value, ["schema_version", "refresh_id", "state", "completed_at", "protocol_version", "capped"], "DAILY_LOOP_REFRESH_INVALID");
	if (input["schema_version"] !== 1 || (input["state"] !== "completed" && input["state"] !== "failed") || typeof input["capped"] !== "boolean")
		return fail("DAILY_LOOP_REFRESH_INVALID");
	return Object.freeze({
		schema_version: 1,
		refresh_id: text(input["refresh_id"], 512, "DAILY_LOOP_REFRESH_INVALID"),
		state: input["state"],
		completed_at: timestamp(input["completed_at"], "DAILY_LOOP_REFRESH_INVALID"),
		protocol_version: integer(input["protocol_version"], 1, MAX_INT, "DAILY_LOOP_REFRESH_INVALID"),
		capped: input["capped"],
	});
}

export function parseDailyLoopBudgets(value: unknown): DailyLoopBudgets {
  const budgets = closedRecord(value, ["max_items", "max_work", "max_bytes"], "DAILY_LOOP_CONFIG_INVALID");
  return Object.freeze({
    max_items: integer(budgets["max_items"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
    max_work: integer(budgets["max_work"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
    max_bytes: integer(budgets["max_bytes"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
  });
}

export function parseDailyLoopOptions(value: unknown): DailyLoopOptions & { readonly recovery_lookback_days: number } {
	const input = closedRecord(
		value,
		[
			"time_zone",
			"owner_id",
			"lease_ms",
			"deadline_ms",
			"recovery_window_ms",
			"recovery_lookback_days",
			"refresh_freshness_ms",
			"budgets",
			"clock",
			"event_source",
			"refresh_reader",
		],
		"DAILY_LOOP_CONFIG_INVALID",
		["morning_local_time"],
	);
	const budgets = parseDailyLoopBudgets(input["budgets"]);
	const source = closedRecord(input["event_source"], ["drain"], "DAILY_LOOP_CONFIG_INVALID");
	const reader = closedRecord(input["refresh_reader"], ["read"], "DAILY_LOOP_CONFIG_INVALID");
	if (
		input["time_zone"] !== "Asia/Seoul" ||
		typeof input["clock"] !== "function" ||
		typeof source["drain"] !== "function" ||
		typeof reader["read"] !== "function"
	)
		return fail("DAILY_LOOP_CONFIG_INVALID");
	const clock = input["clock"];
	const drain = source["drain"];
	const read = reader["read"];
	if (typeof clock !== "function" || typeof drain !== "function" || typeof read !== "function") return fail("DAILY_LOOP_CONFIG_INVALID");
	const providedWait = Reflect.get(clock, "wait");
	const wrappedClock = () => parseDailyLoopInstant(Reflect.apply(clock, undefined, []));
	if (typeof providedWait === "function") Object.assign(wrappedClock, { wait: providedWait });
	const recoveryWindow = integer(input["recovery_window_ms"], 0, 2_592_000_000, "DAILY_LOOP_CONFIG_INVALID");
	const lookback = integer(input["recovery_lookback_days"], 1, 31, "DAILY_LOOP_CONFIG_INVALID");
	if (lookback < Math.ceil(recoveryWindow / 86_400_000) + 1) return fail("DAILY_LOOP_CONFIG_INVALID");
	return Object.freeze({
		time_zone: "Asia/Seoul",
		morning_local_time: parseDailyLoopMorningLocalTime(input["morning_local_time"]),
		owner_id: text(input["owner_id"], 128, "DAILY_LOOP_CONFIG_INVALID"),
		lease_ms: integer(input["lease_ms"], 1, 900_000, "DAILY_LOOP_CONFIG_INVALID"),
		deadline_ms: integer(input["deadline_ms"], 0, 86_400_000, "DAILY_LOOP_CONFIG_INVALID"),
		recovery_window_ms: recoveryWindow,
		recovery_lookback_days: lookback,
		refresh_freshness_ms: integer(input["refresh_freshness_ms"], 0, 86_400_000, "DAILY_LOOP_CONFIG_INVALID"),
		budgets,
		clock: wrappedClock,
		event_source: Object.freeze({
			drain: () => Reflect.apply(drain, undefined, []),
		}),
		refresh_reader: Object.freeze({
			read: (at: Date) => Reflect.apply(read, undefined, [new Date(at.getTime())]),
		}),
	});
}
