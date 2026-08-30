import type Database from "better-sqlite3";
import { DailyControlLoop, dailyPhaseSchedule, type DailyPhase, type DailyRun, type DailyScheduleDecision } from "./daily-control-loop.js";
import { TerminalMemoryError, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";

export type DailyPhaseHandler = (run: DailyRun) => Promise<unknown> | unknown;
export type DailySchedulePlan = Readonly<{
	loop_date: string;
	due: readonly DailyScheduleDecision[];
	recovered_leases: number;
}>;
const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);

function kstParts(now: Date): { date: string; minutes: number } {
	const fields = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Seoul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const value = (name: string): string => fields.find((field) => field.type === name)?.value ?? "";
	return {
		date: `${value("year")}-${value("month")}-${value("day")}`,
		minutes: Number(value("hour")) * 60 + Number(value("minute")),
	};
}

export class DailyControlScheduler {
	private readonly loop: DailyControlLoop;
	constructor(
		source: SqlSource,
		private readonly clock = () => new Date(),
	) {
		this.loop = new DailyControlLoop(dbOf(source), clock);
	}

	plan(now = this.clock()): DailySchedulePlan {
		const parts = kstParts(now);
		const due: DailyScheduleDecision[] = [];
		if (parts.minutes >= 7 * 60 + 15) due.push(dailyPhaseSchedule(parts.date, "morning"));
		if (parts.minutes >= 21 * 60 + 30) due.push(dailyPhaseSchedule(parts.date, "evening"));
		return {
			loop_date: parts.date,
			due,
			recovered_leases: this.loop.recoverExpiredLeases(now),
		};
	}

	async execute(phase: Exclude<DailyPhase, "in_day">, owner: string, handler: DailyPhaseHandler, now = this.clock()): Promise<DailyRun> {
		const at = timestamp(now.toISOString());
		const parts = kstParts(now);
		const run = this.loop.ensureRun(parts.date, phase);
		const claim = this.loop.claim(run.run_id, owner, 30_000, now);
		try {
			const started = this.loop.advance(claim.run_id, owner, claim.lease_fence, "running", undefined, undefined, now);
			const result = await handler(started);
			const verifying = this.loop.advance(started.run_id, owner, started.lease_fence, "verifying", undefined, undefined, new Date(Date.parse(at) + 1));
			return this.loop.advance(verifying.run_id, owner, verifying.lease_fence, "completed", result, undefined, new Date(Date.parse(at) + 2));
		} catch (error) {
			const reason = error instanceof Error ? error.name : "DAILY_HANDLER_FAILED";
			const current = this.loop.get(claim.run_id);
			if (current.state === "claimed" || current.state === "running" || current.state === "verifying")
				return this.loop.advance(current.run_id, owner, current.lease_fence, "failed", undefined, reason, new Date(Date.parse(at) + 1));
			throw new TerminalMemoryError("DAILY_RUN_SETTLEMENT_FAILED");
		}
	}
}
