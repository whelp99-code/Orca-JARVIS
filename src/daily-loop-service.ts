import {
  parseDailyLoopClaim, parseDailyLoopEvent, parseDailyLoopEvents, parseDailyLoopOptions, parseDailyLoopRunId,
  parseDailyLoopUncertainReason,
} from "./daily-loop-input.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { classifyDailyLoopInstant, evaluateRefreshContext, kstLocalDate } from "./daily-loop-time.js";
import { dailyLoopSchedules } from "./daily-loop-schedules.js";
import {
  DailyLoopError, type DailyLoopClaim, type DailyLoopCycleResult, type DailyLoopDue, type DailyLoopFailureCode,
  type DailyLoopOptions, type DailyLoopPreparation, type DailyLoopStep, type DailyLoopStepExecutor,
} from "./daily-loop-types.js";

type Used = { items: number; work: number; bytes: number };
type Cost = Readonly<Used>;
const morningSteps = [
	{ key: "refresh_context", sequence: 1 },
	{ key: "morning_reconcile", sequence: 2 },
] as const;
const eveningSteps = [{ key: "evening_summary", sequence: 1 }] as const;
const MAX_DATE = 8_640_000_000_000_000;

export class DailyControlLoop {
	private readonly options: DailyLoopOptions;
	private observedAt: Date | null = null;
	constructor(
		private readonly store: DailyLoopStore,
		options: DailyLoopOptions,
		private readonly stepExecutor?: DailyLoopStepExecutor,
	) {
		this.options = parseDailyLoopOptions(options);
	}
	private now(): Date {
		return this.options.clock();
	}
	prepare(inputValue: unknown): DailyLoopPreparation {
		const input = parseDailyLoopEvent(inputValue);
		const now = this.now();
		const decision = classifyDailyLoopInstant(now, input);
		if (decision.kind === "not_due") return decision;
		if (decision.kind === "deferred") {
			if (input.kind !== "event") throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
			const due: DailyLoopDue = {
				kind: "due",
				local_date: kstLocalDate(new Date(decision.next_allowed_at)),
				phase: "in_day",
				scheduled_at: input.occurred_at,
				not_before: decision.next_allowed_at,
				event_id: input.event_id,
				occurred_at: input.occurred_at,
				critical: false,
				event_cost: {
					items: input.items,
					work: input.work,
					bytes: input.bytes,
				},
			};
			const prepared = this.prepareDue(due, new Date(input.occurred_at));
			if (prepared.kind !== "prepared") throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
			return { ...decision, run_id: prepared.run_id };
		}
		const created = decision.phase === "in_day" ? new Date(decision.occurred_at ?? decision.scheduled_at) : new Date(decision.scheduled_at);
		return this.prepareDue(decision, created);
	}
	private checkedDate(base: Date, delta: number): Date {
		if (!Number.isSafeInteger(delta) || base.getTime() > MAX_DATE - delta) throw new DailyLoopError("DAILY_LOOP_INSTANT_INVALID");
		return new Date(base.getTime() + delta);
	}
	private prepareDue(due: DailyLoopDue, createdAt: Date): DailyLoopPreparation {
		const notBefore = new Date(due.not_before ?? due.scheduled_at);
		const lifetime = due.phase === "in_day" ? Math.max(1, this.options.deadline_ms) : this.options.recovery_window_ms + Math.max(1, this.options.deadline_ms);
		const deadline = this.checkedDate(notBefore, lifetime);
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
		const policy = due.bypass_reason === undefined ? "ordinary" : `${due.bypass_reason}:${due.critical_reason ?? "missing"}`;
		return {
			key: `event:${eventId}:items=${cost.items}:work=${cost.work}:bytes=${cost.bytes}:${policy}`,
			sequence: 1,
		};
	}
	claim(runIdValue: unknown): DailyLoopClaim {
		const runId = parseDailyLoopRunId(runIdValue);
		return this.store.claim({
			run_id: runId,
			owner_id: this.options.owner_id,
			at: this.now(),
			lease_ms: this.options.lease_ms,
		});
	}
	runNext(claimValue: unknown): boolean {
		return this.advance(parseDailyLoopClaim(claimValue)) === "step_completed";
	}
	private advance(claim: DailyLoopClaim): "step_completed" | "all_completed" | "failed" {
		if (this.stepExecutor !== undefined) return this.stepExecutor.advance(claim);
		const at = this.now();
		if (this.options.deadline_ms === 0 || at.getTime() >= Date.parse(claim.deadline_at)) {
			this.store.fail(claim, "DEADLINE_EXHAUSTED", at);
			return "failed";
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
				return "failed";
			}
			this.store.completeStep({
				claim,
				step,
				detail: this.detail(step, at),
				at: this.now(),
			});
			this.add(used, cost);
			return "step_completed";
		}
		return "all_completed";
	}
	finish(claimValue: unknown): boolean {
		const claim = parseDailyLoopClaim(claimValue);
		let outcome: ReturnType<DailyControlLoop["advance"]>;
		do { outcome = this.advance(claim); } while (outcome === "step_completed");
		if (outcome === "failed") return false;
		if (this.stepExecutor !== undefined) this.stepExecutor.complete(claim);
		else this.store.complete(claim, this.now());
		return true;
	}
	markUncertain(claimValue: unknown, reasonValue: unknown): void {
		const claim = parseDailyLoopClaim(claimValue);
		const reason = parseDailyLoopUncertainReason(reasonValue);
		this.store.uncertain(claim, reason, this.now());
	}
	private detail(step: DailyLoopStep, at: Date): unknown {
		if (step.step_key === "refresh_context") {
			const refresh = this.options.refresh_reader.read(at);
			return evaluateRefreshContext(refresh, this.now(), this.options.refresh_freshness_ms);
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
		if (used.items > this.options.budgets.max_items || cost.items > this.options.budgets.max_items - used.items) return "BUDGET_ITEMS_EXHAUSTED";
		if (used.work > this.options.budgets.max_work || cost.work > this.options.budgets.max_work - used.work) return "BUDGET_WORK_EXHAUSTED";
		if (used.bytes > this.options.budgets.max_bytes || cost.bytes > this.options.budgets.max_bytes - used.bytes) return "BUDGET_BYTES_EXHAUSTED";
		return null;
	}
	private add(used: Used, cost: Cost): void {
		used.items += cost.items;
		used.work += cost.work;
		used.bytes += cost.bytes;
	}
	private processRun(runId: string, completed: string[]): void {
		if (completed.includes(runId) || this.store.steps(runId).length === 0) return;
		try {
			const claim = this.store.claim({
				run_id: runId, owner_id: this.options.owner_id, at: this.now(), lease_ms: this.options.lease_ms,
			}, this.options.recovery_window_ms);
			if (this.finish(claim)) completed.push(runId);
		} catch (error) {
			if (error instanceof DailyLoopError && (error.code === "DAILY_LOOP_LEASE_ACTIVE" || error.code === "DAILY_LOOP_TERMINAL")) return;
			throw error;
		}
	}
	async cycle(): Promise<DailyLoopCycleResult> {
		const now = this.now();
		const completed: string[] = [];
		const scheduled = classifyDailyLoopInstant(now, { kind: "scheduled" });
		const prepared: DailyLoopPreparation[] = this.observedAt === null ? [] : this.recover(now, this.observedAt).prepared;
		if (scheduled.kind !== "due") prepared.unshift({ kind: "not_due" });
		else if (!prepared.some(item => item.kind === "prepared" && item.phase === scheduled.phase && item.local_date === scheduled.local_date)) {
			prepared.push(this.prepareDue(scheduled, now));
		}
		const events = parseDailyLoopEvents(this.options.event_source.drain());
		for (const event of events) prepared.push(this.prepare(event));
		for (const runId of this.store.due(this.now())) this.processRun(runId, completed);
		this.observe(now);
		return { prepared, completed_run_ids: completed };
	}
	private observe(at: Date): void {
		if (this.observedAt === null || at > this.observedAt) this.observedAt = at;
	}
	private recover(now: Date, after: Date | null) {
		const { from, through, schedules } = dailyLoopSchedules(now, this.options.recovery_lookback_days, after);
		const prepared: DailyLoopPreparation[] = [];
		for (const due of schedules) {
			const scheduled = new Date(due.scheduled_at);
			const item = this.prepareDue(due, scheduled); prepared.push(item);
			if (item.kind === "prepared" && now.getTime() - scheduled.getTime() > this.options.recovery_window_ms) {
				this.store.omit(item.run_id, "MISSED_RECOVERY_WINDOW", now);
			}
		}
		return { from, through, prepared };
	}
	async startup(): Promise<DailyLoopCycleResult> {
		const now = this.now();
		const { from, through, prepared } = this.recover(now, null);
		const completed: string[] = [];
		for (const runId of this.store.due(this.now())) this.processRun(runId, completed);
		this.observe(now);
		return {
			prepared,
			completed_run_ids: completed,
			recovery_from_date: from,
			recovery_through_date: through,
		};
	}
}
