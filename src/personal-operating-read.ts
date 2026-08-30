import type Database from "better-sqlite3";
import { projectRecommendations, type RecommendationReadProjection } from "./recommendation-projection.js";
import { TerminalMemoryError, identifier, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";

export type PersonalTodayProjection = Readonly<{
	schema_version: 1;
	generated_at: string;
	loop_date: string;
	runs: readonly Readonly<Record<string, unknown>>[];
	recommendations: RecommendationReadProjection;
	decisions: readonly Readonly<Record<string, unknown>>[];
	notifications: readonly Readonly<Record<string, unknown>>[];
	source_health: readonly Readonly<Record<string, unknown>>[];
	omissions: readonly string[];
}>;
const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);
const records = (value: unknown): readonly Readonly<Record<string, unknown>>[] =>
	Array.isArray(value) ? (value.filter((item) => typeof item === "object" && item !== null) as Readonly<Record<string, unknown>>[]) : [];

export class PersonalOperatingReadModel {
	private readonly db: Database.Database;
	constructor(source: SqlSource) {
		this.db = dbOf(source);
	}

	today(loopDate: string, now: string, limit = 50): PersonalTodayProjection {
		const date = identifier(loopDate, 32);
		const at = timestamp(now);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
			throw new TerminalMemoryError("PERSONAL_READ_INPUT_INVALID");
		const runs = records(
			this.db
				.prepare(
					"SELECT run_id,loop_date,idempotency_key,state,lease_owner,lease_fence,lease_expires_at,expires_at," +
					"result_digest,failure_code FROM daily_loop_runs WHERE loop_date=? ORDER BY run_id LIMIT ?",
				)
				.all(date, limit),
		);
		const notifications = records(
			this.db
				.prepare(
					"SELECT intent_id,correlation_id,urgency,channel,redacted_preview,deep_link,state,expires_at," +
					"created_at,updated_at FROM notification_intents WHERE state NOT IN ('expired','suppressed') ORDER BY created_at DESC,intent_id LIMIT ?",
				)
				.all(limit),
		);
		const decisions = records(
			this.db
				.prepare(
					"SELECT request_id,action,action_level,command_digest,state,requested_by,requested_at," +
					"expires_at FROM control_command_requests WHERE state IN ('pending','approved','claimed') ORDER BY requested_at,request_id LIMIT ?",
				)
				.all(limit),
		).map((item) => ({
			request_id: item.request_id,
			action: item.action,
			action_level: item.action_level,
			command_digest: item.command_digest,
			state: item.state,
			requested_by: item.requested_by,
			requested_at: item.requested_at,
			expires_at: item.expires_at,
		}));
		const sourceHealth = records(
			this.db
				.prepare(
					"SELECT source_id,sequence,checkpoint,observed_at,recorded_at FROM personal_source_checkpoints ORDER BY source_id,sequence DESC LIMIT ?",
				)
				.all(limit),
		);
		const omissions = ["raw_memory_body", "terminal_output", "private_credentials"];
		return {
			schema_version: 1,
			generated_at: at,
			loop_date: date,
			runs,
			recommendations: projectRecommendations(this.db, at, limit),
			decisions,
			notifications,
			source_health: sourceHealth,
			omissions,
		};
	}

	memoryCandidates(now: string, limit = 50): readonly Readonly<Record<string, unknown>>[] {
		timestamp(now);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("PERSONAL_READ_INPUT_INVALID");
		return records(
			this.db
				.prepare(
					"SELECT candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest," +
					"source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,created_at,updated_at " +
					"FROM memory_candidates ORDER BY created_at DESC,candidate_id LIMIT ?",
				)
				.all(limit),
		);
	}

	terminalSessions(limit = 50): readonly Readonly<Record<string, unknown>>[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("PERSONAL_READ_INPUT_INVALID");
		return records(
			this.db
				.prepare(
					"SELECT terminal_id,terminal_incarnation_id,host_id,environment_id,terminal_provider,started_at,ended_at,status," +
					"primary_project_id,created_by,correlation_id FROM terminal_sessions ORDER BY started_at DESC,terminal_id LIMIT ?",
				)
				.all(limit),
		);
	}
	failures(limit = 50): readonly Readonly<Record<string, unknown>>[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("PERSONAL_READ_INPUT_INVALID");
		return records(
			this.db
				.prepare(
					"SELECT failure_id,terminal_id,project_id,failure_class,summary,status,opened_at,resolved_at,resolution_id,severity " +
					"FROM terminal_failures ORDER BY opened_at DESC,failure_id LIMIT ?",
				)
				.all(limit),
		);
	}

	improvements(limit = 50): readonly Readonly<Record<string, unknown>>[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("PERSONAL_READ_INPUT_INVALID");
		return records(
			this.db
				.prepare(
					"SELECT improvement_id,closeout_id,category,summary,issue_draft_digest,created_at " +
					"FROM terminal_improvements ORDER BY created_at DESC,improvement_id LIMIT ?",
				)
				.all(limit),
		);
	}
}
