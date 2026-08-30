import type Database from "better-sqlite3";
import { TerminalMemoryError, identifier, terminalDigest, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";

export type WorkflowCorrelationInput = Readonly<{
	correlation_id: string;
	project_id: string;
	work_id: string;
	recommendation_id?: string | null;
	task_id: string;
	dispatch_id?: string | null;
	terminal_id?: string | null;
	terminal_incarnation_id?: string | null;
	worktree_id?: string | null;
	agent_session_id?: string | null;
	progress_id?: string | null;
	verification_id?: string | null;
	created_at: string;
}>;
export type CorrelationEventInput = Readonly<{
	event_id: string;
	correlation_id: string;
	kind: "dispatch" | "terminal" | "worktree" | "progress" | "verification" | "failure" | "resolution" | "closeout";
	idempotency_key: string;
	payload: unknown;
	evidence_digest?: string | null;
	created_at: string;
}>;
export type WorkflowCorrelation = Readonly<WorkflowCorrelationInput>;

const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);
const row = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

export class WorkflowCorrelationStore {
	private readonly db: Database.Database;
	constructor(source: SqlSource) {
		this.db = dbOf(source);
	}

	link(input: WorkflowCorrelationInput): WorkflowCorrelation {
		const parsed = this.parse(input);
		const existing = row(this.db.prepare("SELECT * FROM workflow_correlations WHERE correlation_id=?").get(parsed.correlation_id));
		if (existing !== undefined) {
			if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new TerminalMemoryError("WORKFLOW_CORRELATION_CONFLICT");
			return this.output(existing);
		}
		this.db
			.prepare(`INSERT INTO workflow_correlations
      (correlation_id,project_id,work_id,recommendation_id,task_id,dispatch_id,terminal_id,terminal_incarnation_id,
       worktree_id,agent_session_id,progress_id,verification_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				parsed.correlation_id,
				parsed.project_id,
				parsed.work_id,
				parsed.recommendation_id,
				parsed.task_id,
				parsed.dispatch_id,
				parsed.terminal_id,
				parsed.terminal_incarnation_id,
				parsed.worktree_id,
				parsed.agent_session_id,
				parsed.progress_id,
				parsed.verification_id,
				parsed.created_at,
			);
		return this.output(row(this.db.prepare("SELECT * FROM workflow_correlations WHERE correlation_id=?").get(parsed.correlation_id))!);
	}

	append(input: CorrelationEventInput): void {
		const correlation = identifier(input.correlation_id);
		const created = timestamp(input.created_at);
		const kind = input.kind;
		if (!["dispatch", "terminal", "worktree", "progress", "verification", "failure", "resolution", "closeout"].includes(kind))
			throw new TerminalMemoryError("WORKFLOW_EVENT_KIND_INVALID");
		if (row(this.db.prepare("SELECT correlation_id FROM workflow_correlations WHERE correlation_id=?").get(correlation)) === undefined)
			throw new TerminalMemoryError("WORKFLOW_CORRELATION_NOT_FOUND");
		const event = {
			event_id: identifier(input.event_id),
			correlation_id: correlation,
			kind,
			idempotency_key: identifier(input.idempotency_key),
			payload_digest: terminalDigest(input.payload),
			evidence_digest: input.evidence_digest === null || input.evidence_digest === undefined ? null : identifier(input.evidence_digest),
			created_at: created,
		};
		const prior = row(
			this.db.prepare("SELECT payload_digest FROM workflow_correlation_events WHERE idempotency_key=?").get(event.idempotency_key),
		);
		if (prior !== undefined) {
			if (prior.payload_digest !== event.payload_digest) throw new TerminalMemoryError("WORKFLOW_EVENT_REPLAY_CONFLICT");
			return;
		}
		this.db
			.prepare(`INSERT INTO workflow_correlation_events
      (event_id,correlation_id,kind,idempotency_key,payload_digest,evidence_digest,created_at)
      VALUES(?,?,?,?,?,?,?)`)
			.run(
				event.event_id,
				event.correlation_id,
				event.kind,
				event.idempotency_key,
				event.payload_digest,
				event.evidence_digest,
				event.created_at,
			);
	}

	get(correlationId: string): WorkflowCorrelation {
		const found = row(this.db.prepare("SELECT * FROM workflow_correlations WHERE correlation_id=?").get(identifier(correlationId)));
		if (found === undefined) throw new TerminalMemoryError("WORKFLOW_CORRELATION_NOT_FOUND");
		return this.output(found);
	}

	private parse(input: WorkflowCorrelationInput): WorkflowCorrelationInput {
		timestamp(input.created_at);
		return {
			correlation_id: identifier(input.correlation_id),
			project_id: identifier(input.project_id),
			work_id: identifier(input.work_id),
			recommendation_id:
				input.recommendation_id === null || input.recommendation_id === undefined ? null : identifier(input.recommendation_id),
			task_id: identifier(input.task_id),
			dispatch_id: input.dispatch_id === null || input.dispatch_id === undefined ? null : identifier(input.dispatch_id),
			terminal_id: input.terminal_id === null || input.terminal_id === undefined ? null : identifier(input.terminal_id),
			terminal_incarnation_id:
				input.terminal_incarnation_id === null || input.terminal_incarnation_id === undefined
					? null
					: identifier(input.terminal_incarnation_id),
			worktree_id: input.worktree_id === null || input.worktree_id === undefined ? null : identifier(input.worktree_id),
			agent_session_id: input.agent_session_id === null || input.agent_session_id === undefined ? null : identifier(input.agent_session_id),
			progress_id: input.progress_id === null || input.progress_id === undefined ? null : identifier(input.progress_id),
			verification_id: input.verification_id === null || input.verification_id === undefined ? null : identifier(input.verification_id),
			created_at: input.created_at,
		};
	}

	private output(value: Record<string, unknown>): WorkflowCorrelation {
		const optional = (field: string): string | null => (value[field] === null ? null : String(value[field]));
		return {
			correlation_id: String(value.correlation_id),
			project_id: String(value.project_id),
			work_id: String(value.work_id),
			recommendation_id: optional("recommendation_id"),
			task_id: String(value.task_id),
			dispatch_id: optional("dispatch_id"),
			terminal_id: optional("terminal_id"),
			terminal_incarnation_id: optional("terminal_incarnation_id"),
			worktree_id: optional("worktree_id"),
			agent_session_id: optional("agent_session_id"),
			progress_id: optional("progress_id"),
			verification_id: optional("verification_id"),
			created_at: String(value.created_at),
		};
	}
}
