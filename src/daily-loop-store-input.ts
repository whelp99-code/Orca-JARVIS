import {
	parseDailyLoopClaim,
	parseDailyLoopDate,
	parseDailyLoopIdentity,
	parseDailyLoopInstant,
	parseDailyLoopPhase,
	parseDailyLoopRunId,
	parseDailyLoopUncertainReason,
} from "./daily-loop-input.js";
import {
	DailyLoopError,
	type DailyLoopClaim,
	type DailyLoopDue,
	type DailyLoopFailureCode,
	type DailyLoopStep,
	type DailyLoopUncertainReason,
} from "./daily-loop-types.js";

type StepDefinition = { readonly key: string; readonly sequence: number };
export type ParsedPrepareRunInput = {
	readonly due: DailyLoopDue;
	readonly created_at: Date;
	readonly deadline_at: Date;
	readonly steps: readonly StepDefinition[];
};
export type ParsedClaimInput = {
	readonly run_id: string;
	readonly owner_id: string;
	readonly at: Date;
	readonly lease_ms: number;
};
export type ParsedCheckpointInput = {
	readonly claim: DailyLoopClaim;
	readonly step_id: string | null;
	readonly state: "running" | "verifying" | "completed" | "failed" | "uncertain";
	readonly detail: unknown;
	readonly at: Date;
};
export type ParsedCompleteStepInput = {
	readonly claim: DailyLoopClaim;
	readonly step: DailyLoopStep;
	readonly detail: unknown;
	readonly at: Date;
};

const invalid = (): never => {
	throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
};
function record(value: unknown): Record<string, unknown> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
		const result: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return invalid();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable || !("value" in descriptor))
				return invalid();
			result[key] = descriptor.value;
		}
		return result;
	} catch (error) {
		// no-excuse-ok: catch -- hostile proxy boundary
		if (error instanceof DailyLoopError) throw error;
		return invalid();
	}
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	const input = record(value);
	const actual = Object.keys(input);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
	return input;
}
function timestamp(value: unknown): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalid();
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) return invalid();
	return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : invalid();
}
function detail(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isSafeInteger(value) ? value : invalid();
	if (depth >= 8) return invalid();
	if (Array.isArray(value)) {
		try {
			if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256) return invalid();
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable || !("value" in descriptor))
					return invalid();
				result.push(detail(descriptor.value, depth + 1));
			}
			return Object.freeze(result);
		} catch (error) {
			// no-excuse-ok: catch -- hostile array boundary
			if (error instanceof DailyLoopError) throw error;
			return invalid();
		}
	}
	const input = record(value);
	if (Object.keys(input).length > 256) return invalid();
	return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, item]) => [parseDailyLoopIdentity(key), detail(item, depth + 1)])));
}
function due(value: unknown): DailyLoopDue {
	const input = record(value);
	const allowed = [
		"kind",
		"local_date",
		"phase",
		"scheduled_at",
		"not_before",
		"event_id",
		"occurred_at",
		"critical",
		"critical_reason",
		"event_cost",
		"bypass_reason",
	];
	if (Object.keys(input).some((key) => !allowed.includes(key)) || input["kind"] !== "due") return invalid();
	const phase = parseDailyLoopPhase(input["phase"]);
	const scheduledAt = timestamp(input["scheduled_at"]);
	const result: DailyLoopDue = {
		kind: "due",
		local_date: parseDailyLoopDate(input["local_date"]),
		phase,
		scheduled_at: scheduledAt,
	};
	if (input["not_before"] !== undefined) Object.assign(result, { not_before: timestamp(input["not_before"]) });
	if (phase === "in_day") {
		const cost = closed(input["event_cost"], ["items", "work", "bytes"]);
		const critical = input["critical"];
		if (critical !== true && critical !== false) return invalid();
		Object.assign(result, {
			event_id: parseDailyLoopIdentity(input["event_id"]),
			occurred_at: timestamp(input["occurred_at"]),
			critical,
			event_cost: {
				items: integer(cost["items"], 0, 2_147_483_647),
				work: integer(cost["work"], 0, 2_147_483_647),
				bytes: integer(cost["bytes"], 0, 2_147_483_647),
			},
		});
		if (critical)
			Object.assign(result, {
				critical_reason: parseDailyLoopIdentity(input["critical_reason"]),
			});
		if (input["bypass_reason"] !== undefined) {
			if (input["bypass_reason"] !== "critical_quiet_hours_bypass") return invalid();
			Object.assign(result, { bypass_reason: input["bypass_reason"] });
		}
	}
	return Object.freeze(result);
}
function steps(value: unknown): readonly StepDefinition[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256) return invalid();
	return Object.freeze(
		value.map((item, index) => {
			const input = closed(item, ["key", "sequence"]);
			const sequence = integer(input["sequence"], 1, 256);
			if (sequence !== index + 1) return invalid();
			return Object.freeze({
				key: parseDailyLoopIdentity(input["key"]),
				sequence,
			});
		}),
	);
}

export function parseStorePrepare(value: unknown): ParsedPrepareRunInput {
	const input = closed(value, ["due", "created_at", "deadline_at", "steps"]);
	return Object.freeze({
		due: due(input["due"]),
		created_at: parseDailyLoopInstant(input["created_at"]),
		deadline_at: parseDailyLoopInstant(input["deadline_at"]),
		steps: steps(input["steps"]),
	});
}
export function parseStoreClaim(value: unknown): ParsedClaimInput {
	const input = closed(value, ["run_id", "owner_id", "at", "lease_ms"]);
	return Object.freeze({
		run_id: parseDailyLoopRunId(input["run_id"]),
		owner_id: parseDailyLoopIdentity(input["owner_id"]),
		at: parseDailyLoopInstant(input["at"]),
		lease_ms: integer(input["lease_ms"], 1, 900_000),
	});
}
export function parseStoreCheckpoint(value: unknown): ParsedCheckpointInput {
	const input = closed(value, ["claim", "step_id", "state", "detail", "at"]);
	const state = input["state"];
	if (state !== "running" && state !== "verifying" && state !== "completed" && state !== "failed" && state !== "uncertain") return invalid();
	return Object.freeze({
		claim: parseDailyLoopClaim(input["claim"]),
		step_id: input["step_id"] === null ? null : parseDailyLoopRunId(input["step_id"]),
		state,
		detail: detail(input["detail"]),
		at: parseDailyLoopInstant(input["at"]),
	});
}
export function parseStoreCompleteStep(value: unknown): ParsedCompleteStepInput {
	const input = closed(value, ["claim", "step", "detail", "at"]);
	const step = closed(input["step"], ["step_id", "sequence", "step_key", "state"]);
	const state = step["state"];
	if (
		state !== "pending" &&
		state !== "claimed" &&
		state !== "running" &&
		state !== "verifying" &&
		state !== "completed" &&
		state !== "failed" &&
		state !== "uncertain"
	)
		return invalid();
	return Object.freeze({
		claim: parseDailyLoopClaim(input["claim"]),
		step: Object.freeze({
			step_id: parseDailyLoopRunId(step["step_id"]),
			sequence: integer(step["sequence"], 1, 256),
			step_key: parseDailyLoopIdentity(step["step_key"]),
			state,
		}),
		detail: detail(input["detail"]),
		at: parseDailyLoopInstant(input["at"]),
	});
}
export function parseFailure(value: unknown): DailyLoopFailureCode {
	if (
		value !== "MISSED_RECOVERY_WINDOW" &&
		value !== "DEADLINE_EXHAUSTED" &&
		value !== "BUDGET_ITEMS_EXHAUSTED" &&
		value !== "BUDGET_WORK_EXHAUSTED" &&
		value !== "BUDGET_BYTES_EXHAUSTED" &&
		value !== "EXECUTION_FAILED"
	)
		return invalid();
	return value;
}
/** A refusing executor's own error code, kept verbatim when it is one and named plainly when not. */
export function failureDetail(value: unknown, fallback: string): string {
	return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : fallback;
}
export function parseUncertain(value: unknown): DailyLoopUncertainReason {
	return parseDailyLoopUncertainReason(value);
}
export function parseStoreDetail(value: unknown): unknown {
	return detail(value);
}
