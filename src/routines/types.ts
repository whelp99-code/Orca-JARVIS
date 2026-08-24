export type MissedRunPolicy = "skip" | "run_once" | "catch_up_bounded";

export type RoutineSchedule =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "daily"; readonly hour: number; readonly timezone: string };

export type RoutineAction =
  | { readonly kind: "notify"; readonly template: string }
  | { readonly kind: "protected"; readonly template: string };

export type Routine = {
  readonly id: string;
  readonly owner: string;
  readonly project: string;
  readonly timezone: string;
  readonly schedule: RoutineSchedule;
  readonly action: RoutineAction;
  readonly riskTier: number;
  readonly environment: string;
  readonly enabled: boolean;
  readonly nextDue: number;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly catchUpCap: number;
  readonly generation: string;
};

export type RoutineRun = {
  readonly runId: string;
  readonly routineId: string;
  readonly dueAt: number;
  readonly owner: string;
  readonly fence: number;
  readonly kind: "notify" | "approval_request";
};
