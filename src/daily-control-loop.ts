import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";

export type DailyPhase = "morning" | "in_day" | "evening";
export type DailyRunState = "pending" | "claimed" | "running" | "verifying" | "completed" | "failed" | "uncertain";
export type DailyClock = () => Date;
export type DailyRun = Readonly<{
	run_id: string;
	loop_date: string;
	phase: DailyPhase;
	correlation_id: string;
	idempotency_key: string;
	state: DailyRunState;
	lease_owner: string | null;
	lease_fence: number;
	lease_expires_at: string | null;
	expires_at: string;
	result_digest: string | null;
	failure_code: string | null;
}>;
export type DailyScheduleDecision = Readonly<{
	phase: DailyPhase;
	scheduled_at: string;
	action: "run" | "defer" | "bypass";
	reason: string;
}>;

export class DailyControlLoopError extends Error {
	constructor(
		readonly code: string,
		message = code,
	) {
		super(message);
	}
}

const PHASE_MINUTES: Record<DailyPhase, number> = {
	morning: 7 * 60 + 15,
	in_day: -1,
	evening: 21 * 60 + 30,
};
const ACTIVE_STATES = ["claimed", "running", "verifying"] as const;
const TRANSITIONS: Readonly<Record<DailyRunState, readonly DailyRunState[]>> = {
	pending: ["claimed", "failed"],
	claimed: ["running", "failed", "uncertain"],
	running: ["verifying", "failed", "uncertain"],
	verifying: ["completed", "failed", "uncertain"],
	completed: [],
	failed: [],
	uncertain: [],
};

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
	const parsed = Date.parse(value);
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requirePhase(phase: DailyPhase): void {
	if (phase !== "morning" && phase !== "in_day" && phase !== "evening") {
		throw new DailyControlLoopError("DAILY_LOOP_PHASE_INVALID");
	}
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function scheduledUtc(loopDate: string, phase: DailyPhase): string {
	if (!validDate(loopDate)) throw new DailyControlLoopError("DAILY_LOOP_DATE_INVALID");
	requirePhase(phase);
	if (phase === "in_day") throw new DailyControlLoopError("DAILY_LOOP_EVENT_DRIVEN");
	const minutes = PHASE_MINUTES[phase];
	return new Date(
		Date.parse(`${loopDate}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+09:00`),
	).toISOString();
}

export function dailyPhaseSchedule(loopDate: string, phase: DailyPhase): DailyScheduleDecision {
	if (!validDate(loopDate)) throw new DailyControlLoopError("DAILY_LOOP_DATE_INVALID");
	requirePhase(phase);
	const scheduled_at = phase === "in_day" ? `${loopDate}T00:00:00.000Z` : scheduledUtc(loopDate, phase);
	return { phase, scheduled_at, action: "run", reason: "scheduled" };
}

export function quietHoursDecision(now: Date, urgency: "info" | "action" | "critical"): "deliver" | "defer" | "bypass" {
	const kstHour = Number(
		new Intl.DateTimeFormat("en-US", {
			timeZone: "Asia/Seoul",
			hour: "2-digit",
			hour12: false,
		}).format(now),
	);
	const inQuiet = kstHour >= 22 || kstHour < 7;
	if (!inQuiet) return "deliver";
	if (urgency === "critical") return "bypass";
	return "defer";
}

export class DailyControlLoop {
	constructor(
		private readonly db: Database.Database,
		private readonly clock: DailyClock = () => new Date(),
	) {}

	ensureRun(loopDate: string, phase: DailyPhase, expiresAt?: string): DailyRun {
		requirePhase(phase);
		if (!validDate(loopDate)) throw new DailyControlLoopError("DAILY_LOOP_DATE_INVALID");
		const at = this.clock();
		const createdAt = at.toISOString();
		const scheduled = phase === "in_day" ? createdAt : scheduledUtc(loopDate, phase);
		if (phase !== "in_day" && at.getTime() < Date.parse(scheduled) - 24 * 60 * 60 * 1000) {
			throw new DailyControlLoopError("DAILY_LOOP_SCHEDULE_INVALID");
		}
		const idempotency_key = `daily:${loopDate}:${phase}`;
		const run_id = `run:pos:v1:${digest({ loopDate, phase }).slice(7)}`;
		const correlation_id = `corr:pos:v1:${digest({ loopDate, phase, kind: "daily" }).slice(7)}`;
		const expiry = expiresAt ?? new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString();
		if (!validUtcTimestamp(expiry) || Date.parse(expiry) <= at.getTime()) {
			throw new DailyControlLoopError("DAILY_LOOP_EXPIRY_INVALID");
		}
		this.db
			.prepare(`INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`)
			.run(run_id, loopDate, correlation_id, idempotency_key, "pending", expiry, createdAt, createdAt);
		return this.get(run_id);
	}

	recoverExpiredLeases(now = this.clock()): number {
		if (!Number.isFinite(now.getTime())) throw new DailyControlLoopError("DAILY_LOOP_CLOCK_INVALID");
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM daily_loop_runs WHERE state IN ('claimed','running','verifying') AND lease_expires_at<=?")
			.get(now.toISOString()) as { count: number };
		return Number(row.count);
	}

	claim(runId: string, owner: string, leaseMs = 30_000, now = this.clock()): DailyRun {
		if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000) {
			throw new DailyControlLoopError("DAILY_LOOP_CLAIM_INVALID");
		}
		if (!Number.isFinite(now.getTime())) throw new DailyControlLoopError("DAILY_LOOP_CLOCK_INVALID");
		const current = this.db.prepare("SELECT lease_fence,state,lease_owner,lease_expires_at,expires_at FROM daily_loop_runs WHERE run_id=?").get(runId) as
			| {
					lease_fence: number;
					state: string;
					lease_owner: string | null;
					lease_expires_at: string | null;
					expires_at: string;
			  }
			| undefined;
		if (!current) throw new DailyControlLoopError("DAILY_LOOP_NOT_FOUND");
		if (!validUtcTimestamp(current.expires_at) || Date.parse(current.expires_at) <= now.getTime()) {
			throw new DailyControlLoopError("DAILY_LOOP_EXPIRED");
		}
		const reclaimable =
			ACTIVE_STATES.includes(current.state as (typeof ACTIVE_STATES)[number]) &&
			current.lease_expires_at !== null &&
			Date.parse(current.lease_expires_at) <= now.getTime();
		if (current.state !== "pending" && !reclaimable) throw new DailyControlLoopError("DAILY_LOOP_NOT_PENDING");
		if (current.state === "pending" && (current.lease_fence !== 0 || current.lease_owner !== null || current.lease_expires_at !== null)) {
			throw new DailyControlLoopError("DAILY_LOOP_CLAIM_INVALID");
		}
		const leaseExpiresAt = new Date(Math.min(now.getTime() + leaseMs, Date.parse(current.expires_at))).toISOString();
		if (Date.parse(leaseExpiresAt) <= now.getTime()) throw new DailyControlLoopError("DAILY_LOOP_CLAIM_INVALID");
		const fence = Number(current.lease_fence) + 1;
		const nextState = reclaimable ? current.state : "claimed";
		const changed = this.db
			.prepare(`UPDATE daily_loop_runs SET state=?,lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
      WHERE run_id=? AND lease_fence=? AND (state='pending' OR (state IN ('claimed','running','verifying') AND lease_expires_at<=?))`)
			.run(nextState, owner, fence, leaseExpiresAt, now.toISOString(), runId, current.lease_fence, now.toISOString());
		if (changed.changes !== 1) throw new DailyControlLoopError("DAILY_LOOP_CLAIM_CONFLICT");
		return this.get(runId);
	}

	advance(
		runId: string,
		owner: string,
		fence: number,
		state: Exclude<DailyRunState, "pending" | "claimed">,
		result?: unknown,
		failureCode?: string,
		now = this.clock(),
	): DailyRun {
		if (!Number.isSafeInteger(fence) || fence < 1) throw new DailyControlLoopError("DAILY_LOOP_FENCE_INVALID");
		if (!Number.isFinite(now.getTime())) throw new DailyControlLoopError("DAILY_LOOP_CLOCK_INVALID");
		if (state !== "running" && state !== "verifying" && state !== "completed" && state !== "failed" && state !== "uncertain") {
			throw new DailyControlLoopError("DAILY_LOOP_STATE_INVALID");
		}
		const current = this.db.prepare("SELECT state,lease_owner,lease_fence,lease_expires_at,expires_at FROM daily_loop_runs WHERE run_id=?").get(runId) as
			| {
					state: DailyRunState;
					lease_owner: string | null;
					lease_fence: number;
					lease_expires_at: string | null;
					expires_at: string;
			  }
			| undefined;
		if (!current) throw new DailyControlLoopError("DAILY_LOOP_NOT_FOUND");
		if (
			current.lease_owner !== owner ||
			current.lease_fence !== fence ||
			current.lease_expires_at === null ||
			Date.parse(current.lease_expires_at) <= now.getTime() ||
			Date.parse(current.expires_at) <= now.getTime()
		) {
			throw new DailyControlLoopError("DAILY_LOOP_STALE_FENCE");
		}
		if (!TRANSITIONS[current.state].includes(state)) throw new DailyControlLoopError("DAILY_LOOP_TRANSITION_INVALID");
		if (state === "completed" && result === undefined) throw new DailyControlLoopError("DAILY_LOOP_RESULT_REQUIRED");
		if ((state === "failed" || state === "uncertain") && !failureCode) throw new DailyControlLoopError("DAILY_LOOP_FAILURE_REQUIRED");
		const resultDigest = result === undefined ? null : digest(result);
		const terminal = state === "completed" || state === "failed" || state === "uncertain";
		const leaseSql = terminal ? "lease_owner=NULL,lease_expires_at=NULL," : "";
		const changed = this.db
			.prepare(`UPDATE daily_loop_runs SET state=?,result_digest=COALESCE(?,result_digest),failure_code=?,${leaseSql}updated_at=?
      WHERE run_id=? AND state IN ('claimed','running','verifying') AND lease_owner=? AND lease_fence=?`)
			.run(state, resultDigest, failureCode ?? null, now.toISOString(), runId, owner, fence);
		if (changed.changes !== 1) throw new DailyControlLoopError("DAILY_LOOP_STALE_FENCE");
		return this.get(runId);
	}

	get(runId: string): DailyRun {
		const row = this.db
			.prepare(`SELECT run_id,loop_date,correlation_id,idempotency_key,state,lease_owner,lease_fence,lease_expires_at,expires_at,result_digest,failure_code
      FROM daily_loop_runs WHERE run_id=?`)
			.get(runId) as Record<string, unknown> | undefined;
		if (!row) throw new DailyControlLoopError("DAILY_LOOP_NOT_FOUND");
		return {
			...row,
			loop_date: String(row.loop_date),
			phase: this.phaseFromId(String(row.idempotency_key)),
			state: String(row.state) as DailyRunState,
			run_id: String(row.run_id),
			correlation_id: String(row.correlation_id),
			idempotency_key: String(row.idempotency_key),
			lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
			lease_fence: Number(row.lease_fence),
			lease_expires_at: row.lease_expires_at === null ? null : String(row.lease_expires_at),
			expires_at: String(row.expires_at),
			result_digest: row.result_digest === null ? null : String(row.result_digest),
			failure_code: row.failure_code === null ? null : String(row.failure_code),
		};
	}

	list(loopDate?: string): readonly DailyRun[] {
		const rows = (
			loopDate === undefined
				? this.db.prepare("SELECT run_id FROM daily_loop_runs ORDER BY loop_date,run_id").all()
				: this.db.prepare("SELECT run_id FROM daily_loop_runs WHERE loop_date=? ORDER BY run_id").all(loopDate)
		) as Array<{ run_id: string }>;
		return rows.map((row) => this.get(row.run_id));
	}

	private phaseFromId(idempotencyKey: string): DailyPhase {
		const phase = idempotencyKey.split(":").at(-1);
		if (phase !== "morning" && phase !== "in_day" && phase !== "evening") throw new DailyControlLoopError("DAILY_LOOP_ID_INVALID");
		return phase;
	}
}

export { ACTIVE_STATES };
