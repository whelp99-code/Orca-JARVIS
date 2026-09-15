export const DAILY_LOOP_PHASES = ["morning", "in_day", "evening"] as const;
export type DailyLoopPhase = (typeof DAILY_LOOP_PHASES)[number];
export type DailyLoopState = "pending" | "claimed" | "running" | "verifying" | "completed" | "failed" | "uncertain";
export type DailyLoopBudgets = {
	readonly max_items: number;
	readonly max_work: number;
	readonly max_bytes: number;
};
/** The local time the morning phase is scheduled for, unless a configuration names another. */
export const DAILY_LOOP_DEFAULT_MORNING_LOCAL_TIME = "07:15" as const;
/** The evening phase's local time, which the morning phase may not be moved onto. */
export const DAILY_LOOP_EVENING_LOCAL_TIME = "21:30" as const;
export type DailyLoopConfig = {
	readonly time_zone: "Asia/Seoul";
	/**
	 * Local HH:MM the morning phase is due at. Absent means the default above, so a deployment that
	 * never named a time keeps the schedule it always had. This is configuration, not a clock
	 * override: the instant a run is measured against is still the real one the caller supplies.
	 */
	readonly morning_local_time?: string;
	readonly owner_id: string;
	readonly lease_ms: number;
	readonly deadline_ms: number;
	readonly recovery_window_ms: number;
	readonly recovery_lookback_days: number;
	readonly refresh_freshness_ms: number;
	readonly budgets: DailyLoopBudgets;
};
type DailyLoopEventBase = {
	readonly kind: "event";
	readonly event_id: string;
	readonly occurred_at: string;
	readonly items: number;
	readonly work: number;
	readonly bytes: number;
};
export type DailyLoopEvent =
	| (DailyLoopEventBase & { readonly critical: false })
	| (DailyLoopEventBase & {
			readonly critical: true;
			readonly critical_reason: string;
	  });
export type DailyLoopScheduleInput = { readonly kind: "scheduled" };
export type DailyLoopInput = DailyLoopScheduleInput | DailyLoopEvent;
export type RefreshCompletion = {
	readonly schema_version: 1;
	readonly refresh_id: string;
	readonly state: "completed" | "failed";
	readonly completed_at: string;
	readonly protocol_version: number;
	readonly capped: boolean;
};
export type RefreshContext = {
	readonly state: "ready" | "no_data" | "degraded";
	readonly reason: "refresh_fresh" | "refresh_failed" | "refresh_missing" | "refresh_stale" | "refresh_incompatible" | "refresh_capped" | "refresh_invalid";
	readonly refresh_id: string | null;
};
export interface DailyLoopEventSource {
	drain(): unknown;
}
export interface RefreshCompletionReader {
	read(at: Date): unknown;
}
export type DailyLoopDue = {
	readonly kind: "due";
	readonly local_date: string;
	readonly phase: DailyLoopPhase;
	readonly scheduled_at: string;
	readonly not_before?: string;
	readonly event_id?: string;
	readonly occurred_at?: string;
	readonly critical?: boolean;
	readonly critical_reason?: string;
	readonly event_cost?: {
		readonly items: number;
		readonly work: number;
		readonly bytes: number;
	};
	readonly bypass_reason?: "critical_quiet_hours_bypass";
};
export type DailyLoopCalendarDeferred = {
	readonly kind: "deferred";
	readonly next_allowed_at: string;
	readonly deferred_key: string;
};
export type DailyLoopDeferred = DailyLoopCalendarDeferred & {
	readonly run_id: string;
};
export type DailyLoopNotDue = { readonly kind: "not_due" };
export type DailyLoopCalendarDecision = DailyLoopDue | DailyLoopCalendarDeferred | DailyLoopNotDue;
export type DailyLoopClaim = {
	readonly run_id: string;
	readonly owner_id: string;
	readonly fence: number;
	readonly lease_expires_at: string;
	readonly deadline_at: string;
};
export type DailyLoopStep = {
	readonly step_id: string;
	readonly sequence: number;
	readonly step_key: string;
	readonly state: DailyLoopState;
};
export type DailyLoopPreparation =
	| {
			readonly kind: "prepared";
			readonly run_id: string;
			readonly phase: DailyLoopPhase;
			readonly local_date: string;
	  }
	| DailyLoopDeferred
	| DailyLoopNotDue;
export type DailyLoopCycleResult = {
	readonly prepared: readonly DailyLoopPreparation[];
	readonly completed_run_ids: readonly string[];
	readonly recovery_from_date?: string;
	readonly recovery_through_date?: string;
};
export type DailyLoopOptions = DailyLoopConfig & {
	readonly clock: () => Date;
	readonly event_source: DailyLoopEventSource;
	readonly refresh_reader: RefreshCompletionReader;
};
export type DailyLoopFailureCode =
	| "MISSED_RECOVERY_WINDOW"
	| "DEADLINE_EXHAUSTED"
	| "BUDGET_ITEMS_EXHAUSTED"
	| "BUDGET_WORK_EXHAUSTED"
	| "BUDGET_BYTES_EXHAUSTED";
export type DailyLoopAdvance = "step_completed" | "all_completed" | "failed";
export interface DailyLoopStepExecutor {
  advance(claim: DailyLoopClaim): DailyLoopAdvance;
  complete(claim: DailyLoopClaim): void;
}
export type DailyLoopUncertainReason = "EXECUTION_OUTCOME_UNCERTAIN";
export type DailyLoopErrorCode =
	| "DAILY_LOOP_CONFIG_INVALID"
	| "DAILY_LOOP_HANDLER_UNAVAILABLE"
	| "DAILY_LOOP_EVENT_INVALID"
	| "DAILY_LOOP_REFRESH_INVALID"
	| "DAILY_LOOP_DATE_INVALID"
	| "DAILY_LOOP_INSTANT_INVALID"
	| "DAILY_LOOP_LEASE_ACTIVE"
	| "DAILY_LOOP_STALE_LEASE"
	| "DAILY_LOOP_TERMINAL"
	| "DAILY_LOOP_IDENTITY_CONFLICT"
	| "DAILY_LOOP_INTEGRITY_FAILURE";
export class DailyLoopError extends Error {
	readonly name = "DailyLoopError";
	constructor(readonly code: DailyLoopErrorCode) {
		super(code);
	}
}
