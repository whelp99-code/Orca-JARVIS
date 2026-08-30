import { DailyLoopStore } from "./daily-loop-store.js";
import { classifyDailyLoopInstant, evaluateRefreshContext, kstInstant, kstLocalDate } from "./daily-loop-time.js";
import {
  DailyLoopError,
  type DailyLoopClaim,
  type DailyLoopCycleResult,
  type DailyLoopDue,
  type DailyLoopFailureCode,
  type DailyLoopInput,
  type DailyLoopOptions,
  type DailyLoopPreparation,
  type DailyLoopStep,
} from "./daily-loop-types.js";

type Cost = {
  readonly items: number;
  readonly work: number;
  readonly bytes: number;
};
type Used = { items: number; work: number; bytes: number };
const morningSteps = [
  { key: "refresh_context", sequence: 1 },
  { key: "morning_reconcile", sequence: 2 },
] as const;
const eveningSteps = [{ key: "evening_summary", sequence: 1 }] as const;
const validInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

export class DailyControlLoop {
  constructor(
    private readonly store: DailyLoopStore,
    private readonly options: DailyLoopOptions,
  ) {
    if (
      options.time_zone !== "Asia/Seoul" ||
      options.owner_id.length === 0 ||
      !validInteger(options.lease_ms) ||
      options.lease_ms < 1 ||
      options.lease_ms > 15 * 60_000 ||
      !validInteger(options.deadline_ms) ||
      !validInteger(options.recovery_window_ms) ||
      !validInteger(options.refresh_freshness_ms) ||
      !validInteger(options.budgets.max_items) ||
      !validInteger(options.budgets.max_work) ||
      !validInteger(options.budgets.max_bytes)
    )
      throw new DailyLoopError("DAILY_LOOP_CONFIG_INVALID");
  }
  prepare(input: DailyLoopInput): DailyLoopPreparation {
    if (input.kind === "event" && (input.event_id.length === 0 || !validInteger(input.items) || !validInteger(input.work) || !validInteger(input.bytes)))
      throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
    const now = this.options.clock();
    const decision = classifyDailyLoopInstant(now, input);
    if (decision.kind !== "due") return decision;
    return this.prepareDue(decision, now);
  }
  private prepareDue(due: DailyLoopDue, createdAt: Date): DailyLoopPreparation {
    const deadline = new Date(createdAt.getTime() + Math.max(1, this.options.deadline_ms));
    const steps = due.phase === "morning" ? morningSteps : due.phase === "evening" ? eveningSteps : [this.eventStep(due)];
    const runId = this.store.prepare({
      due,
      created_at: createdAt,
      deadline_at: deadline,
      steps,
    });
    return {
      kind: "prepared",
      run_id: runId,
      phase: due.phase,
      local_date: due.local_date,
    };
  }
  private eventStep(due: DailyLoopDue): {
    readonly key: string;
    readonly sequence: 1;
  } {
    const eventId = due.event_id ?? "event";
    const cost = due.event_cost ?? { items: 1, work: 1, bytes: 1 };
    const bypass = due.bypass_reason === undefined ? "ordinary" : due.bypass_reason;
    return {
      key: `event:${eventId}:items=${cost.items}:work=${cost.work}:bytes=${cost.bytes}:${bypass}`,
      sequence: 1,
    };
  }
  claim(runId: string): DailyLoopClaim {
    return this.store.claim({
      run_id: runId,
      owner_id: this.options.owner_id,
      at: this.options.clock(),
      lease_ms: this.options.lease_ms,
    });
  }
  runNext(claim: DailyLoopClaim): boolean {
    const at = this.options.clock();
    if (this.options.deadline_ms === 0 || at.getTime() >= Date.parse(claim.deadline_at)) {
      this.store.fail(claim, "DEADLINE_EXHAUSTED", at);
      return false;
    }
    this.store.start(claim, at);
    const steps = this.store.steps(claim.run_id);
    const used: Used = { items: 0, work: 0, bytes: 0 };
    for (const step of steps) {
      if (step.state === "completed") {
        this.add(used, this.cost(step));
        continue;
      }
      const cost = this.cost(step);
      const exhausted = this.exhausted(used, cost);
      if (exhausted !== null) {
        this.store.fail(claim, exhausted, at);
        return false;
      }
      const detail = this.detail(step, at);
      this.store.completeStep({ claim, step, detail, at });
      this.add(used, cost);
      return true;
    }
    return false;
  }
  finish(claim: DailyLoopClaim): void {
    while (this.runNext(claim)) {
      /* each iteration persists one completed logical step */
    }
    const steps = this.store.steps(claim.run_id);
    if (steps.every((step) => step.state === "completed")) this.store.complete(claim, this.options.clock());
  }
  private detail(step: DailyLoopStep, at: Date): unknown {
    if (step.step_key === "refresh_context") {
      return evaluateRefreshContext(this.options.refresh_reader.read(at), at, this.options.refresh_freshness_ms);
    }
    if (step.step_key.startsWith("event:")) return { event: step.step_key, boundary: "no_external_effect" };
    return { step_key: step.step_key, boundary: "no_external_effect" };
  }
  private cost(step: DailyLoopStep): Cost {
    if (step.step_key === "refresh_context") return { items: 1, work: 1, bytes: 256 };
    if (step.step_key === "morning_reconcile") return { items: 1, work: 1, bytes: 128 };
    if (step.step_key === "evening_summary") return { items: 1, work: 1, bytes: 256 };
    const event = /:items=(\d+):work=(\d+):bytes=(\d+):/.exec(step.step_key);
    if (event !== null)
      return {
        items: Number(event[1]),
        work: Number(event[2]),
        bytes: Number(event[3]),
      };
    return { items: 1, work: 1, bytes: Math.min(1024, step.step_key.length) };
  }
  private exhausted(used: Used, cost: Cost): DailyLoopFailureCode | null {
    if (used.items + cost.items > this.options.budgets.max_items) return "BUDGET_ITEMS_EXHAUSTED";
    if (used.work + cost.work > this.options.budgets.max_work) return "BUDGET_WORK_EXHAUSTED";
    if (used.bytes + cost.bytes > this.options.budgets.max_bytes) return "BUDGET_BYTES_EXHAUSTED";
    return null;
  }
  private add(used: Used, cost: Cost): void {
    used.items += cost.items;
    used.work += cost.work;
    used.bytes += cost.bytes;
  }
  private process(preparation: DailyLoopPreparation, completed: string[]): void {
    if (preparation.kind !== "prepared" || completed.includes(preparation.run_id)) return;
    try {
      const claim = this.claim(preparation.run_id);
      this.finish(claim);
      completed.push(preparation.run_id);
    } catch (error) {
      if (error instanceof DailyLoopError && (error.code === "DAILY_LOOP_LEASE_ACTIVE" || error.code === "DAILY_LOOP_TERMINAL")) return;
      throw error;
    }
  }
  async cycle(): Promise<DailyLoopCycleResult> {
    const prepared: DailyLoopPreparation[] = [this.prepare({ kind: "scheduled" })];
    for (const event of this.options.event_source.drain()) prepared.push(this.prepare(event));
    const completed: string[] = [];
    for (const item of prepared) this.process(item, completed);
    return { prepared, completed_run_ids: completed };
  }
  async startup(): Promise<DailyLoopCycleResult> {
    const now = this.options.clock();
    const date = kstLocalDate(now);
    const prepared: DailyLoopPreparation[] = [];
    for (const schedule of [
      { phase: "morning", hour: 7, minute: 15 },
      { phase: "evening", hour: 21, minute: 30 },
    ] as const) {
      const scheduled = kstInstant(date, schedule.hour, schedule.minute);
      const elapsed = now.getTime() - scheduled.getTime();
      if (elapsed < 0) continue;
      const due: DailyLoopDue = {
        kind: "due",
        local_date: date,
        phase: schedule.phase,
        scheduled_at: scheduled.toISOString(),
      };
      const item = this.prepareDue(due, now);
      prepared.push(item);
      if (item.kind === "prepared" && elapsed > this.options.recovery_window_ms) this.store.omit(item.run_id, "MISSED_RECOVERY_WINDOW", now);
    }
    const completed: string[] = [];
    for (const item of prepared) {
      if (
        item.kind === "prepared" &&
        now.getTime() - Date.parse(item.phase === "morning" ? kstInstant(date, 7, 15).toISOString() : kstInstant(date, 21, 30).toISOString()) <=
          this.options.recovery_window_ms
      )
        this.process(item, completed);
    }
    return { prepared, completed_run_ids: completed };
  }
}
