import type { DoctorCheck, DoctorReport } from "../doctor.js";
import type { SecondBrainReadinessReportV1 } from "../second-brain-readiness.js";

export const DOCTOR_CACHE_MAX_AGE_MS = 120_000;
export const DOCTOR_CACHE_REFRESH_MS = 30_000;

const unknown = {
	state: "unknown",
	reason: "cache_empty",
	checked_at: null,
} as const;

export function checkingSecondBrainReport(): SecondBrainReadinessReportV1 {
	return {
		schema_version: 1,
		capability: "second_brain",
		checked_at: null,
		readiness: "checking",
		stages: {
			installed: unknown,
			configured: unknown,
			protocol_compatible: unknown,
			operational: { state: "unavailable", reason: "cache_empty", checked_at: null },
			authorized: { state: "unauthorized", reason: "cache_empty", checked_at: null, read: false, write: false },
			data_state: unknown,
			last_successful_refresh: {
				state: "missing",
				reason: "cache_empty",
				checked_at: null,
				observed_at: null,
				latest_attempt: "malformed",
			},
			freshness: unknown,
		},
	};
}

export function presentCachedSecondBrain(report: SecondBrainReadinessReportV1, now: Date): SecondBrainReadinessReportV1 {
	if (report.readiness === "checking" || report.checked_at === null) return report;
	const checked = Date.parse(report.checked_at);
	if (!Number.isFinite(checked) || now.getTime() - checked <= DOCTOR_CACHE_MAX_AGE_MS) return report;
	const freshness = report.stages.freshness.state === "fresh"
		? { ...report.stages.freshness, state: "stale" as const, reason: "threshold_exceeded" as const }
		: report.stages.freshness;
	return {
		...report,
		readiness: report.readiness === "ready" ? "degraded" : report.readiness,
		stages: { ...report.stages, freshness },
	};
}

export class DoctorResultCache {
	private current: DoctorReport | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private inflight: Promise<void> | undefined;
	private stopped = false;

	constructor(
		private readonly load: (now: Date) => Promise<DoctorReport>,
		private readonly intervalMs = DOCTOR_CACHE_REFRESH_MS,
	) {}

	start(now: () => Date): void {
		if (this.timer !== undefined || this.stopped) return;
		void this.refresh(now());
		this.timer = setInterval(() => { void this.refresh(now()); }, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	read(now: Date): { readonly secondBrain: SecondBrainReadinessReportV1; readonly checks: readonly DoctorCheck[] } {
		if (this.current === undefined) return { secondBrain: checkingSecondBrainReport(), checks: [] };
		return {
			secondBrain: presentCachedSecondBrain(this.current.second_brain, now),
			checks: this.current.checks,
		};
	}

	private async refresh(now: Date): Promise<void> {
		if (this.stopped || this.inflight !== undefined) return;
		this.inflight = this.load(now).then((report) => {
			if (!this.stopped) this.current = report;
		}).catch(() => undefined).finally(() => {
			this.inflight = undefined;
		});
		await this.inflight;
	}
}
