import { readFileSync, readlinkSync } from "node:fs";
import { JarvisError } from "./db.js";

export type TaskExecutionClockBudget = { readonly clock_id: string; readonly deadline_uptime_ms: number };
type Reading = { clock_id: string; uptime_ms: number };
const unavailable = (): never => { throw new JarvisError("TASK_EXECUTION_CLOCK_UNAVAILABLE"); };

/** Linux boot-time clock shared by host processes; bind the time namespace as well as the boot UUID. */
export function readTaskExecutionClock(): Reading {
  if (process.platform !== "linux") return unavailable();
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = readlinkSync("/proc/self/ns/time");
    const uptime = readFileSync("/proc/uptime", "utf8");
    const match = /^(\d+)\.(\d{2}) \d+\.\d{2}\n?$/.exec(uptime);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)
      || !/^time:\[\d+\]$/.test(namespace) || !match) return unavailable();
    const ms = Number(match[1]) * 1000 + Number(match[2]) * 10;
    if (!Number.isSafeInteger(ms) || ms < 0) return unavailable();
    return { clock_id: `${boot}/${namespace}`, uptime_ms: ms };
  } catch { return unavailable(); }
}

export function taskExecutionClockBudget(timeoutMs: number): TaskExecutionClockBudget {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) return unavailable();
  const clock = readTaskExecutionClock();
  const deadline = clock.uptime_ms + timeoutMs;
  if (!Number.isSafeInteger(deadline)) return unavailable();
  return { clock_id: clock.clock_id, deadline_uptime_ms: deadline };
}

export function remainingTaskExecutionBudget(budget: TaskExecutionClockBudget): number {
  const clock = readTaskExecutionClock();
  if (!budget || budget.clock_id !== clock.clock_id || !Number.isSafeInteger(budget.deadline_uptime_ms)) return unavailable();
  // /proc/uptime is truncated to centiseconds. Subtract a full tick, never credit unknown fractional time.
  const remaining = budget.deadline_uptime_ms - clock.uptime_ms - 10;
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new JarvisError("TASK_EXECUTION_DEADLINE_EXCEEDED");
  return remaining;
}
