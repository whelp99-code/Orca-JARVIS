import type Database from "better-sqlite3";
import {
	eventKind,
	host,
	identifier,
	jsonList,
	outcome,
	safeSummary,
	terminalDigest,
	text,
	timestamp,
	TerminalMemoryError,
} from "./terminal-memory-validation.js";
import type {
	CheckpointInput,
	CloseoutInput,
	FailureInput,
	ProjectSegmentInput,
	ResolutionInput,
	TerminalEvent,
	TerminalEventInput,
	TerminalSession,
	TerminalSessionInput,
} from "./terminal-memory-types.js";
import * as sessionEvents from "./terminal-work-memory-session.js";
import * as operations from "./terminal-work-memory-operations.js";

export type SqlSource = Database.Database | Readonly<{ db: Database.Database }>;
const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);
const row = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const rows = (value: unknown): readonly Record<string, unknown>[] =>
	Array.isArray(value) ? (value.filter((item) => typeof item === "object" && item !== null) as Record<string, unknown>[]) : [];

export function sessionFrom(value: Record<string, unknown>): TerminalSession {
	return {
		terminal_id: String(value.terminal_id),
		terminal_incarnation_id: String(value.terminal_incarnation_id),
		host_id: host(value.host_id),
		environment_id: String(value.environment_id),
		terminal_provider: String(value.terminal_provider),
		started_at: String(value.started_at),
		ended_at: value.ended_at === null ? null : String(value.ended_at),
		status: String(value.status) as TerminalSession["status"],
		primary_project_id: value.primary_project_id === null ? null : String(value.primary_project_id),
		created_by: String(value.created_by),
		correlation_id: String(value.correlation_id),
	};
}

export class TerminalWorkMemory {
	readonly db: Database.Database;
	constructor(source: SqlSource) {
		this.db = dbOf(source);
	}
	lookupSession(terminalId: string, incarnationId: string): Record<string, unknown> | undefined {
		return row(
			this.db.prepare("SELECT * FROM terminal_sessions WHERE terminal_id=? AND terminal_incarnation_id=?").get(terminalId, incarnationId),
		);
	}

	lookupAnySession(terminalId: string): Record<string, unknown> | undefined {
		return row(this.db.prepare("SELECT terminal_id FROM terminal_sessions WHERE terminal_id=?").get(terminalId));
	}

	rows(value: unknown): readonly Record<string, unknown>[] {
		return rows(value);
	}

	toSession(value: Record<string, unknown>): TerminalSession {
		return sessionFrom(value);
	}
	startSession(input: TerminalSessionInput): TerminalSession {
		return sessionEvents.startSession(this, input);
	}

	endSession(terminalId: string, incarnationId: string, endedAt: string): TerminalSession {
		return sessionEvents.endSession(this, terminalId, incarnationId, endedAt);
	}

	recordSegment(input: ProjectSegmentInput): void {
		sessionEvents.recordSegment(this, input);
	}

	recordEvent(input: TerminalEventInput): TerminalEvent {
		return sessionEvents.recordEvent(this, input);
	}

	openFailure(input: FailureInput): void {
		operations.openFailure(this, input);
	}

	resolveFailure(input: ResolutionInput): void {
		operations.resolveFailure(this, input);
	}

	finishWork(input: CloseoutInput): TerminalCloseoutResult {
		return operations.finishWork(this, input);
	}

	checkpoint(input: CheckpointInput): void {
		operations.checkpoint(this, input);
	}

	unresolvedFailures(limit = 100): readonly TerminalFailureView[] {
		return operations.unresolvedFailures(this, limit);
	}

	terminalContext(terminalId: string, limit = 50): TerminalContextView {
		return operations.terminalContext(this, terminalId, limit);
	}

	decisionQueue(limit = 100): readonly Readonly<Record<string, unknown>>[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("TERMINAL_LIMIT_INVALID");
		return rows(
			this.db
				.prepare(
					"SELECT request_id,action,action_level,command_digest,state,requested_by,requested_at,expires_at "
					+ "FROM control_command_requests WHERE state IN ('pending','approved','claimed') ORDER BY requested_at,request_id LIMIT ?",
				)
				.all(limit),
		);
	}

	public requireSession(terminalId: string, incarnationId: string): TerminalSession {
		const id = identifier(terminalId);
		const incarnation = identifier(incarnationId);
		const found = row(
			this.db.prepare("SELECT * FROM terminal_sessions WHERE terminal_id=? AND terminal_incarnation_id=?").get(id, incarnation),
		);
		if (found === undefined) throw new TerminalMemoryError("TERMINAL_SESSION_NOT_FOUND");
		return sessionFrom(found);
	}

	public event(eventId: string): TerminalEvent {
		const found = row(this.db.prepare("SELECT * FROM terminal_events WHERE event_id=?").get(identifier(eventId)));
		if (found === undefined) throw new TerminalMemoryError("TERMINAL_EVENT_NOT_FOUND");
		return {
			event_id: String(found.event_id),
			terminal_id: String(found.terminal_id),
			terminal_incarnation_id: String(found.terminal_incarnation_id),
			sequence: Number(found.sequence),
			kind: eventKind(found.kind),
			occurred_at: String(found.occurred_at),
			started_at: found.started_at === null ? null : String(found.started_at),
			finished_at: found.finished_at === null ? null : String(found.finished_at),
			duration_ms: found.duration_ms === null ? null : Number(found.duration_ms),
			exit_code: found.exit_code === null ? null : Number(found.exit_code),
			outcome: outcome(found.outcome),
			command_class: String(found.command_class),
			command_digest: String(found.command_digest),
			stdout_digest: found.stdout_digest === null ? null : String(found.stdout_digest),
			stderr_digest: found.stderr_digest === null ? null : String(found.stderr_digest),
			evidence_ref: found.evidence_ref === null ? null : String(found.evidence_ref),
			redaction_state: "digest_only",
			correlation_id: String(found.correlation_id),
		};
	}

	public validateSession(input: TerminalSessionInput): TerminalSessionInput & { primary_project_id: string | null } {
		const started = timestamp(input.started_at);
		host(input.host_id);
		return {
			terminal_id: identifier(input.terminal_id),
			terminal_incarnation_id: identifier(input.terminal_incarnation_id),
			host_id: input.host_id,
			environment_id: identifier(input.environment_id),
			terminal_provider: text(input.terminal_provider, 64),
			started_at: started,
			primary_project_id:
				input.primary_project_id === null || input.primary_project_id === undefined ? null : identifier(input.primary_project_id),
			created_by: identifier(input.created_by),
			correlation_id: identifier(input.correlation_id),
		};
	}

	public validateCheckpoint(input: CheckpointInput): CheckpointInput & { checkpoint_id: string } {
		return {
			...input,
			checkpoint_id: identifier(input.checkpoint_id),
			correlation_id: identifier(input.correlation_id),
			terminal_id: input.terminal_id === null || input.terminal_id === undefined ? null : identifier(input.terminal_id),
			work_id: input.work_id === null || input.work_id === undefined ? null : identifier(input.work_id),
			purpose: safeSummary(input.purpose),
			decision: safeSummary(input.decision),
			failure_summary: input.failure_summary === null || input.failure_summary === undefined ? null : safeSummary(input.failure_summary),
			verification_summary:
				input.verification_summary === null || input.verification_summary === undefined ? null : safeSummary(input.verification_summary),
			next_step: input.next_step === null || input.next_step === undefined ? null : safeSummary(input.next_step),
			created_at: timestamp(input.created_at),
		};
	}

	public validateCloseout(input: CloseoutInput): CloseoutInput & { canonical_digest: string } {
		const signed = timestamp(input.signed_at);
		const arrays = [
			input.terminal_ids,
			input.project_ids,
			input.verified_result,
			input.failed_items,
			input.unresolved_items,
			input.artifacts,
			input.commit_refs,
			input.issue_refs,
			input.improvements,
			input.next_actions,
		];
		arrays.forEach((array) => jsonList(array));
		const digest = terminalDigest({ ...input, signed_at: signed });
		return {
			...input,
			closeout_id: identifier(input.closeout_id),
			work_id: identifier(input.work_id),
			correlation_id: identifier(input.correlation_id),
			signed_at: signed,
			canonical_digest: digest,
		};
	}

	public closeout(value: Record<string, unknown>): TerminalCloseoutResult {
		return {
			closeout_id: String(value.closeout_id),
			work_id: String(value.work_id),
			correlation_id: String(value.correlation_id),
			outcome: String(value.outcome) as TerminalCloseoutResult["outcome"],
			canonical_digest: String(value.canonical_digest),
			verified_result: JSON.parse(String(value.verified_result_json)) as string[],
			unresolved_items: JSON.parse(String(value.unresolved_items_json)) as string[],
		};
	}

	public audit(kind: string, id: string, correlation: string, payload: unknown, at: string): void {
		this.db
			.prepare(`INSERT INTO terminal_operation_audit_events
      (event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
			.run(
				`audit:${kind}:${id}`,
				`terminal.${kind}`,
				kind,
				id,
				null,
				correlation,
				null,
				terminalDigest({ kind, id, correlation, payload, at }),
				at,
			);
	}
}

export type TerminalCloseoutResult = Readonly<{
	closeout_id: string;
	work_id: string;
	correlation_id: string;
	outcome: import("./terminal-memory-types.js").WorkOutcome;
	canonical_digest: string;
	verified_result: readonly string[];
	unresolved_items: readonly string[];
}>;
export type TerminalFailureView = Readonly<{
	failure_id: string;
	terminal_id: string;
	project_id: string | null;
	status: import("./terminal-memory-types.js").FailureStatus;
	severity: "P0" | "P1" | "P2" | "P3";
	summary: string;
}>;
export type TerminalContextView = Readonly<{
	terminal_id: string;
	sessions: readonly TerminalSession[];
	events: readonly Readonly<Record<string, unknown>>[];
	failures: readonly TerminalFailureView[];
}>;
