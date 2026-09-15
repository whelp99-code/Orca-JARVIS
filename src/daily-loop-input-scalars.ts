import {
	DAILY_LOOP_DEFAULT_MORNING_LOCAL_TIME,
	DAILY_LOOP_EVENING_LOCAL_TIME,
	DailyLoopError,
	type DailyLoopClaim,
	type DailyLoopPhase,
} from "./daily-loop-types.js";

export const MAX_INT = 2_147_483_647;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const fail = (code: ConstructorParameters<typeof DailyLoopError>[0]): never => {
	throw new DailyLoopError(code);
};

/**
 * A record with exactly `keys`, plus any of `optional`. Every required key must be present, no
 * unknown key is tolerated, and an absent optional key reads as undefined.
 */
export function closedRecord(
	value: unknown,
	keys: readonly string[],
	code: ConstructorParameters<typeof DailyLoopError>[0],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail(code);
		const actual = Reflect.ownKeys(value);
		if (actual.some((key) => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))) return fail(code);
		if (keys.some((key) => !actual.includes(key))) return fail(code);
		for (const key of actual) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable || !("value" in descriptor))
				return fail(code);
		}
		return Object.fromEntries([...keys, ...optional].map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]));
	} catch (error) {
		// no-excuse-ok: catch -- hostile proxy boundary
		if (error instanceof DailyLoopError) throw error;
		return fail(code);
	}
}

export function openRecord(value: unknown, code: ConstructorParameters<typeof DailyLoopError>[0]): Record<string, unknown> {
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

export function integer(value: unknown, minimum: number, maximum: number, code: ConstructorParameters<typeof DailyLoopError>[0]): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fail(code);
}

export function text(value: unknown, maximum: number, code: ConstructorParameters<typeof DailyLoopError>[0]): string {
	if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximum)
		return fail(code);
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point === undefined || point < 32 || point === 127) return fail(code);
	}
	return value;
}

/**
 * One local HH:MM a phase may be scheduled at. Absent means the shipped morning time; the evening
 * time is refused so a configuration can never make one instant due as two phases.
 */
export function parseDailyLoopMorningLocalTime(value: unknown): string {
	if (value === undefined) return DAILY_LOOP_DEFAULT_MORNING_LOCAL_TIME;
	if (typeof value !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) || value === DAILY_LOOP_EVENING_LOCAL_TIME) {
		return fail("DAILY_LOOP_CONFIG_INVALID");
	}
	return value;
}
/** The same time as the hour and minute a calendar compares against. */
export function dailyLoopLocalTimeParts(value: unknown): { readonly hour: number; readonly minute: number } {
	const [hour, minute] = parseDailyLoopMorningLocalTime(value).split(":");
	return { hour: Number(hour), minute: Number(minute) };
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

export function timestamp(value: unknown, code: ConstructorParameters<typeof DailyLoopError>[0]): string {
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
