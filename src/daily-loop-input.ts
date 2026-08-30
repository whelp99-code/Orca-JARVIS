import {
	DailyLoopError,
	type DailyLoopClaim,
	type DailyLoopEvent,
	type DailyLoopOptions,
	type DailyLoopPhase,
	type RefreshCompletion,
} from "./daily-loop-types.js";

const MAX_INT = 2_147_483_647;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (code: ConstructorParameters<typeof DailyLoopError>[0]): never => {
	throw new DailyLoopError(code);
};

function closedRecord(value: unknown, keys: readonly string[], code: ConstructorParameters<typeof DailyLoopError>[0]): Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail(code);
		const actual = Reflect.ownKeys(value);
		if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return fail(code);
		for (const key of actual) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable || !("value" in descriptor))
				return fail(code);
		}
		return Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]));
	} catch (error) {
		// no-excuse-ok: catch -- hostile proxy boundary
		if (error instanceof DailyLoopError) throw error;
		return fail(code);
	}
}

function openRecord(value: unknown, code: ConstructorParameters<typeof DailyLoopError>[0]): Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail(code);
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key !== "string")) return fail(code);
		return closedRecord(
			value,
			keys.filter((key): key is string => typeof key === "string"),
			code,
		);
	} catch (error) {
		// no-excuse-ok: catch -- hostile proxy boundary
		if (error instanceof DailyLoopError) throw error;
		return fail(code);
	}
}

function integer(value: unknown, minimum: number, maximum: number, code: ConstructorParameters<typeof DailyLoopError>[0]): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fail(code);
}

function text(value: unknown, maximum: number, code: ConstructorParameters<typeof DailyLoopError>[0]): string {
	if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximum)
		return fail(code);
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point === undefined || point < 32 || point === 127) return fail(code);
	}
	return value;
}

export function parseDailyLoopPhase(value: unknown): DailyLoopPhase {
	if (value !== "morning" && value !== "in_day" && value !== "evening") return fail("DAILY_LOOP_EVENT_INVALID");
	return value;
}

export function parseDailyLoopIdentity(value: unknown): string {
	return text(value, 512, "DAILY_LOOP_EVENT_INVALID");
}
export function parseDailyLoopRunId(value: unknown): string {
	return text(value, 128, "DAILY_LOOP_EVENT_INVALID");
}
export function parseDailyLoopFreshness(value: unknown): number {
	return integer(value, 0, 86_400_000, "DAILY_LOOP_CONFIG_INVALID");
}

export function parseDailyLoopDate(value: unknown): string {
	if (typeof value !== "string" || !DATE.test(value)) return fail("DAILY_LOOP_DATE_INVALID");
	const [yearText, monthText, dayText] = value.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return fail("DAILY_LOOP_DATE_INVALID");
	const instant = new Date(Date.UTC(year, month - 1, day));
	if (instant.getUTCFullYear() !== year || instant.getUTCMonth() + 1 !== month || instant.getUTCDate() !== day) return fail("DAILY_LOOP_DATE_INVALID");
	return value;
}

export function parseDailyLoopInstant(value: unknown): Date {
	try {
		if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Date.prototype) return fail("DAILY_LOOP_INSTANT_INVALID");
		const epoch = Date.prototype.getTime.call(value);
		if (!Number.isFinite(epoch) || !Number.isInteger(epoch)) return fail("DAILY_LOOP_INSTANT_INVALID");
		return new Date(epoch);
	} catch (error) {
		// no-excuse-ok: catch -- hostile date boundary
		if (error instanceof DailyLoopError) throw error;
		return fail("DAILY_LOOP_INSTANT_INVALID");
	}
}

function timestamp(value: unknown, code: ConstructorParameters<typeof DailyLoopError>[0]): string {
	if (typeof value !== "string" || !TIMESTAMP.test(value)) return fail(code);
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? value : fail(code);
}

export function parseDailyLoopClaim(value: unknown): DailyLoopClaim {
	const input = closedRecord(value, ["run_id", "owner_id", "fence", "lease_expires_at", "deadline_at"], "DAILY_LOOP_EVENT_INVALID");
	return Object.freeze({
		run_id: parseDailyLoopRunId(input["run_id"]),
		owner_id: text(input["owner_id"], 128, "DAILY_LOOP_EVENT_INVALID"),
		fence: integer(input["fence"], 1, Number.MAX_SAFE_INTEGER, "DAILY_LOOP_EVENT_INVALID"),
		lease_expires_at: timestamp(input["lease_expires_at"], "DAILY_LOOP_EVENT_INVALID"),
		deadline_at: timestamp(input["deadline_at"], "DAILY_LOOP_EVENT_INVALID"),
	});
}

export function parseDailyLoopUncertainReason(value: unknown): "EXECUTION_OUTCOME_UNCERTAIN" {
	if (value !== "EXECUTION_OUTCOME_UNCERTAIN") return fail("DAILY_LOOP_EVENT_INVALID");
	return value;
}

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
	);
	const budgets = closedRecord(input["budgets"], ["max_items", "max_work", "max_bytes"], "DAILY_LOOP_CONFIG_INVALID");
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
	const recoveryWindow = integer(input["recovery_window_ms"], 0, 2_592_000_000, "DAILY_LOOP_CONFIG_INVALID");
	const lookback = integer(input["recovery_lookback_days"], 1, 31, "DAILY_LOOP_CONFIG_INVALID");
	if (lookback < Math.ceil(recoveryWindow / 86_400_000) + 1) return fail("DAILY_LOOP_CONFIG_INVALID");
	return Object.freeze({
		time_zone: "Asia/Seoul",
		owner_id: text(input["owner_id"], 128, "DAILY_LOOP_CONFIG_INVALID"),
		lease_ms: integer(input["lease_ms"], 1, 900_000, "DAILY_LOOP_CONFIG_INVALID"),
		deadline_ms: integer(input["deadline_ms"], 0, 86_400_000, "DAILY_LOOP_CONFIG_INVALID"),
		recovery_window_ms: recoveryWindow,
		recovery_lookback_days: lookback,
		refresh_freshness_ms: integer(input["refresh_freshness_ms"], 0, 86_400_000, "DAILY_LOOP_CONFIG_INVALID"),
		budgets: Object.freeze({
			max_items: integer(budgets["max_items"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
			max_work: integer(budgets["max_work"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
			max_bytes: integer(budgets["max_bytes"], 0, MAX_INT, "DAILY_LOOP_CONFIG_INVALID"),
		}),
		clock: () => parseDailyLoopInstant(Reflect.apply(clock, undefined, [])),
		event_source: Object.freeze({
			drain: () => Reflect.apply(drain, undefined, []),
		}),
		refresh_reader: Object.freeze({
			read: (at: Date) => Reflect.apply(read, undefined, [new Date(at.getTime())]),
		}),
	});
}
