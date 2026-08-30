export const DAILY_LOOP_PHASES = ["morning", "in_day", "evening"] as const;
export type DailyLoopPhase = (typeof DAILY_LOOP_PHASES)[number];
export type DailyLoopState = "pending" | "claimed" | "running" | "verifying" | "completed" | "failed" | "uncertain";
export type DailyLoopBudgets = {
  readonly max_items: number;
  readonly max_work: number;
  readonly max_bytes: number;
};
export type DailyLoopConfig = {
  readonly time_zone: "Asia/Seoul";
  readonly owner_id: string;
  readonly lease_ms: number;
  readonly deadline_ms: number;
  readonly recovery_window_ms: number;
  readonly refresh_freshness_ms: number;
  readonly budgets: DailyLoopBudgets;
};
export type DailyLoopEvent = {
  readonly kind: "event";
  readonly event_id: string;
  readonly critical: boolean;
  readonly items: number;
  readonly work: number;
  readonly bytes: number;
};
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
  readonly reason: "refresh_fresh" | "refresh_failed" | "refresh_missing" | "refresh_stale" | "refresh_incompatible" | "refresh_capped";
  readonly refresh_id: string | null;
};
export interface DailyLoopEventSource {
  drain(): readonly DailyLoopEvent[];
}
export interface RefreshCompletionReader {
  read(at: Date): RefreshCompletion | null;
}
export type DailyLoopDue = {
  readonly kind: "due";
  readonly local_date: string;
  readonly phase: DailyLoopPhase;
  readonly scheduled_at: string;
  readonly event_id?: string;
  readonly event_cost?: {
    readonly items: number;
    readonly work: number;
    readonly bytes: number;
  };
  readonly bypass_reason?: "critical_quiet_hours_bypass";
};
export type DailyLoopDeferred = {
  readonly kind: "deferred";
  readonly next_allowed_at: string;
  readonly deferred_key: string;
};
export type DailyLoopNotDue = { readonly kind: "not_due" };
export type DailyLoopCalendarDecision = DailyLoopDue | DailyLoopDeferred | DailyLoopNotDue;
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

export class DailyLoopError extends Error {
  readonly name = "DailyLoopError";
  constructor(
    readonly code:
      | "DAILY_LOOP_CONFIG_INVALID"
      | "DAILY_LOOP_EVENT_INVALID"
      | "DAILY_LOOP_LEASE_ACTIVE"
      | "DAILY_LOOP_STALE_LEASE"
      | "DAILY_LOOP_TERMINAL"
      | "DAILY_LOOP_IDENTITY_CONFLICT",
  ) {
    super(code);
  }
}
