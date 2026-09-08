import { kstInstant, kstLocalDate, previousKstDate } from "./daily-loop-time.js";
import type { DailyLoopDue } from "./daily-loop-types.js";

export function dailyLoopSteps(due: DailyLoopDue): readonly { readonly key: string; readonly sequence: number }[] {
  if (due.phase === "morning") return [
    { key: "refresh_context", sequence: 1 }, { key: "morning_reconcile", sequence: 2 },
  ];
  if (due.phase === "evening") return [{ key: "evening_summary", sequence: 1 }];
  const eventId = due.event_id ?? "event";
  const cost = due.event_cost ?? { items: 1, work: 1, bytes: 1 };
  const policy = due.bypass_reason === undefined ? "ordinary" : `${due.bypass_reason}:${due.critical_reason ?? "missing"}`;
  return [{ key: `event:${eventId}:items=${cost.items}:work=${cost.work}:bytes=${cost.bytes}:${policy}`, sequence: 1 }];
}

// Internal callers supply a parsed clock and the validated 1..31 day lookback.
export function dailyLoopSchedules(at: Date, lookbackDays: number, after: Date | null) {
  const through = kstLocalDate(at);
  const dates = [through];
  let from = through;
  for (let index = 1; index < lookbackDays; index++) {
    from = previousKstDate(from); dates.push(from);
  }
  const schedules: DailyLoopDue[] = [];
  for (const date of dates.reverse()) for (const schedule of [
    { phase: "morning", hour: 7, minute: 15 }, { phase: "evening", hour: 21, minute: 30 },
  ] as const) {
    const scheduled = kstInstant(date, schedule.hour, schedule.minute);
    if (scheduled > at || (after !== null && scheduled <= after)) continue;
    schedules.push({ kind: "due", local_date: date, phase: schedule.phase, scheduled_at: scheduled.toISOString() });
  }
  return { from, through, schedules };
}
