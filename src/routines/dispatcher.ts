import { JarvisError } from "../db.js";
import type { RoutineScheduler } from "./scheduler.js";
import type { RoutineStore } from "./store.js";

export class RoutineDispatcher {
  constructor(private readonly store: RoutineStore, private readonly scheduler: RoutineScheduler, private readonly clock: { now(): number }) {}

  tick(routineId: string, owner: string, generation: string): readonly string[] {
    const produced: string[] = [];
    let safety = 0;
    for (;;) {
      const routine = this.store.get(routineId);
      if (this.clock.now() < routine.nextDue) break;
      safety += 1;
      if (safety > routine.catchUpCap) throw new JarvisError("ROUTINE_CATCHUP_OVERFLOW");
      const fence = this.scheduler.claimDue(routineId, owner, generation);
      const current = this.store.get(routineId);
      const kind = current.action.kind === "protected" || current.riskTier >= 2 ? "approval_request" : "notify";
      const runId = `${routineId}:${current.nextDue}:${fence}`;
      this.store.appendRun({ runId, routineId, dueAt: this.clock.now(), owner, fence, kind });
      this.store.notifyOnce(`notify:${runId}`);
      produced.push(kind);
      if (routine.missedRunPolicy === "run_once" || routine.missedRunPolicy === "skip") break;
    }
    return produced;
  }
}
