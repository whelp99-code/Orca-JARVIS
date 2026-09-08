import { kstInstant, kstLocalDate, previousKstDate } from "./daily-loop-time.js";
import type { DailyLoopDue } from "./daily-loop-types.js";

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
