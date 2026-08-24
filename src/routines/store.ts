import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JarvisError } from "../db.js";
import type { Routine, RoutineRun } from "./types.js";

export class RoutineStore {
  private routines = new Map<string, Routine>();
  private runs: RoutineRun[] = [];
  private notifications = new Set<string>();
  private claimed = new Set<string>();
  constructor(private readonly file?: string) {
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { routines: Routine[]; runs: RoutineRun[]; notifications: string[]; claimed?: string[] };
        this.routines = new Map(parsed.routines.map(item => [item.id, item]));
        this.runs = parsed.runs;
        this.notifications = new Set(parsed.notifications);
        this.claimed = new Set(parsed.claimed ?? []);
      } catch {
        mkdirSync(dirname(file), { recursive: true });
      }
    }
  }

  put(routine: Routine): void {
    if (routine.schedule.kind === "interval" && routine.schedule.everyMs <= 0) throw new JarvisError("ROUTINE_SCHEDULE_INVALID");
    if (routine.schedule.kind === "daily" && (routine.schedule.hour < 0 || routine.schedule.hour > 23)) throw new JarvisError("ROUTINE_SCHEDULE_INVALID");
    if (routine.timezone.length === 0) throw new JarvisError("ROUTINE_TIMEZONE_INVALID");
    this.routines.set(routine.id, routine);
    this.flush();
  }

  get(id: string): Routine {
    const routine = this.routines.get(id);
    if (!routine) throw new JarvisError("ROUTINE_NOT_FOUND");
    return routine;
  }

  list(): readonly Routine[] {
    return [...this.routines.values()];
  }

  appendRun(run: RoutineRun): void {
    this.runs.push(run);
    this.flush();
  }

  claimSlot(routineId: string, dueAt: number): boolean {
    const key = `${routineId}:${dueAt}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    this.flush();
    return true;
  }

  notifyOnce(key: string): boolean {
    if (this.notifications.has(key)) return false;
    this.notifications.add(key);
    this.flush();
    return true;
  }

  get runLog(): readonly RoutineRun[] {
    return this.runs;
  }

  get notificationKeys(): readonly string[] {
    return [...this.notifications];
  }

  private flush(): void {
    if (!this.file) return;
    writeFileSync(this.file, `${JSON.stringify({
      routines: this.list(),
      runs: this.runs,
      notifications: [...this.notifications],
      claimed: [...this.claimed],
    })}\n`);
  }
}
