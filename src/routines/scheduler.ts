import { JarvisError } from "../db.js";
import type { RoutineStore } from "./store.js";
import type { Routine } from "./types.js";

export type Clock = { now(): number };

export class RoutineScheduler {
  private fence = 0;
  constructor(private readonly store: RoutineStore, private readonly clock: Clock) {}

  nextDue(routine: Routine, from: number): number {
    if (routine.schedule.kind === "interval") return from + routine.schedule.everyMs;
    const tz = routine.schedule.timezone;
    try {
      const hour = routine.schedule.hour;
      const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
      let cursor = from;
      for (let step = 0; step < 48; step += 1) {
        cursor += 60 * 60 * 1000;
        if (Number(formatter.format(new Date(cursor))) === hour) return cursor;
      }
      throw new JarvisError("ROUTINE_SCHEDULE_INVALID");
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      throw new JarvisError("ROUTINE_TIMEZONE_INVALID");
    }
  }

  claimDue(routineId: string, owner: string, generation: string): number {
    const routine = this.store.get(routineId);
    if (!routine.enabled) throw new JarvisError("ROUTINE_DISABLED");
    if (routine.generation !== generation) throw new JarvisError("ROUTINE_STALE_GENERATION");
    if (this.clock.now() < routine.nextDue) throw new JarvisError("ROUTINE_NOT_DUE");
    if (!this.store.claimSlot(routineId, routine.nextDue)) throw new JarvisError("ROUTINE_SPLIT_OWNER");
    this.fence += 1;
    const claimed = { ...routine, owner, nextDue: this.nextDue(routine, routine.nextDue) };
    this.store.put(claimed);
    return this.fence;
  }
}
