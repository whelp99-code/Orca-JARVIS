import { dailyLoopLocalTimeParts } from "./daily-loop-input.js";
import { kstInstant, kstLocalDate, previousKstDate } from "./daily-loop-time.js";
import { DAILY_LOOP_EVENING_LOCAL_TIME, type DailyLoopDue } from "./daily-loop-types.js";

const EVENING = { hour: Number(DAILY_LOOP_EVENING_LOCAL_TIME.slice(0, 2)),
  minute: Number(DAILY_LOOP_EVENING_LOCAL_TIME.slice(3, 5)) };

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

// Internal callers supply a parsed clock, the validated 1..31 day lookback, and the configured
// morning local time (absent means the shipped one).
export function dailyLoopSchedules(at: Date, lookbackDays: number, after: Date | null, morningLocalTime?: unknown) {
  const through = kstLocalDate(at);
  const dates = [through];
  let from = through;
  for (let index = 1; index < lookbackDays; index++) {
    from = previousKstDate(from); dates.push(from);
  }
  const morning = dailyLoopLocalTimeParts(morningLocalTime);
  const schedules: DailyLoopDue[] = [];
  for (const date of dates.reverse()) for (const schedule of [
    { phase: "morning", ...morning }, { phase: "evening", ...EVENING },
  ] as const) {
    const scheduled = kstInstant(date, schedule.hour, schedule.minute);
    if (scheduled > at || (after !== null && scheduled <= after)) continue;
    schedules.push({ kind: "due", local_date: date, phase: schedule.phase, scheduled_at: scheduled.toISOString() });
  }
  return { from, through, schedules };
}
