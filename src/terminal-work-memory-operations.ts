import type { CheckpointInput, CloseoutInput, FailureInput } from "./terminal-memory-types.js";
import {
	identifier,
	jsonList,
	safeSummary,
	terminalDigest,
	timestamp,
	TerminalMemoryError,
} from "./terminal-memory-validation.js";
import type {
	TerminalWorkMemory,
	TerminalCloseoutResult,
	TerminalContextView,
	TerminalFailureView,
} from "./terminal-work-memory.js";

export function openFailure(memory: TerminalWorkMemory, input: FailureInput): void {
	const event = memory.event(input.source_event_id);
	if (event.terminal_id !== input.terminal_id || event.terminal_incarnation_id !== input.terminal_incarnation_id)
		throw new TerminalMemoryError("TERMINAL_FAILURE_EVENT_MISMATCH");
	if (!["failed", "timeout", "uncertain"].includes(event.outcome))
		throw new TerminalMemoryError("TERMINAL_FAILURE_OUTCOME_INVALID");
	if (!["P0", "P1", "P2", "P3"].includes(input.severity))
		throw new TerminalMemoryError("TERMINAL_FAILURE_SEVERITY_INVALID");
	memory.db
		.prepare(`INSERT INTO terminal_failures
    (failure_id,terminal_id,terminal_incarnation_id,project_id,source_event_id,failure_class,summary,status,opened_at,resolved_at,resolution_id,severity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			identifier(input.failure_id),
			identifier(input.terminal_id),
			identifier(input.terminal_incarnation_id),
			input.project_id === null || input.project_id === undefined ? null : identifier(input.project_id),
			identifier(input.source_event_id),
			input.failure_class,
			safeSummary(input.summary),
			"open",
			event.occurred_at,
			null,
			null,
			input.severity,
		);
	memory.audit(
		"terminal_failure",
		input.failure_id,
		event.correlation_id,
		{ status: "open", severity: input.severity },
		event.occurred_at,
	);
}

export function resolveFailure(
	memory: TerminalWorkMemory,
	input: import("./terminal-memory-types.js").ResolutionInput,
): void {
	const failureId = identifier(input.failure_id);
	const failure = memory.db.prepare("SELECT * FROM terminal_failures WHERE failure_id=?").get(failureId) as
		| Record<string, unknown>
		| undefined;
	if (failure === undefined) throw new TerminalMemoryError("TERMINAL_FAILURE_NOT_FOUND");
	if (failure.status === "resolved") throw new TerminalMemoryError("TERMINAL_FAILURE_ALREADY_RESOLVED");
	const sourceIds = input.source_event_ids.map((value) => identifier(value));
	if (sourceIds.length === 0 || sourceIds.length > 32) throw new TerminalMemoryError("TERMINAL_LIST_LIMIT");
	sourceIds.forEach((eventId) => memory.event(eventId));
	const verified = timestamp(input.verified_at);
	const summary = safeSummary(input.summary);
	memory.db.transaction(() => {
		memory.db
			.prepare(`INSERT INTO terminal_resolutions
      (resolution_id,failure_id,source_event_ids_json,summary,verification_id,verified_at,correlation_id)
      VALUES(?,?,?,?,?,?,?)`)
			.run(
				identifier(input.resolution_id),
				failureId,
				jsonList(sourceIds, 32),
				summary,
				identifier(input.verification_id),
				verified,
				identifier(input.correlation_id),
			);
		memory.db
			.prepare(
				"UPDATE terminal_failures SET status='resolved',resolved_at=?,resolution_id=? WHERE failure_id=? AND status IN ('open','investigating')",
			)
			.run(verified, input.resolution_id, failureId);
	})();
	memory.audit("terminal_resolution", input.resolution_id, input.correlation_id, { failure_id: failureId }, verified);
}

export function finishWork(memory: TerminalWorkMemory, input: CloseoutInput): TerminalCloseoutResult {
	const parsed = memory.validateCloseout(input);
	const prior = memory.db.prepare("SELECT * FROM terminal_closeouts WHERE closeout_id=?").get(parsed.closeout_id) as
		| Record<string, unknown>
		| undefined;
	if (prior !== undefined) {
		if (String(prior.canonical_digest) !== parsed.canonical_digest)
			throw new TerminalMemoryError("TERMINAL_CLOSEOUT_CONFLICT");
		return memory.closeout(prior);
	}
	for (const terminalId of parsed.terminal_ids)
		if (memory.lookupAnySession(terminalId) === undefined) throw new TerminalMemoryError("TERMINAL_SESSION_NOT_FOUND");
	if (parsed.outcome === "success") {
		if (parsed.verified_result.length === 0 || parsed.unresolved_items.length > 0)
			throw new TerminalMemoryError("TERMINAL_COMPLETION_EVIDENCE_REQUIRED");
		const open = memory.db
			.prepare(
				"SELECT COUNT(*) AS count FROM terminal_failures WHERE terminal_id IN "
				+ "(SELECT value FROM json_each(?)) AND severity IN ('P0','P1') AND status IN ('open','investigating')",
			)
			.get(jsonList(parsed.terminal_ids)) as { count: number };
		if (Number(open.count) !== 0) throw new TerminalMemoryError("TERMINAL_OPEN_FAILURES");
	}
	memory.db
		.prepare(`INSERT INTO terminal_closeouts
    (closeout_id,work_id,correlation_id,terminal_ids_json,project_ids_json,outcome,verified_result_json,
     failed_items_json,unresolved_items_json,artifacts_json,commit_refs_json,issue_refs_json,improvements_json,next_actions_json,
     canonical_digest,signed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			parsed.closeout_id,
			parsed.work_id,
			parsed.correlation_id,
			jsonList(parsed.terminal_ids),
			jsonList(parsed.project_ids),
			parsed.outcome,
			jsonList(parsed.verified_result),
			jsonList(parsed.failed_items),
			jsonList(parsed.unresolved_items),
			jsonList(parsed.artifacts),
			jsonList(parsed.commit_refs),
			jsonList(parsed.issue_refs),
			jsonList(parsed.improvements),
			jsonList(parsed.next_actions),
			parsed.canonical_digest,
			parsed.signed_at,
		);
	memory.audit(
		"terminal_closeout",
		parsed.closeout_id,
		parsed.correlation_id,
		{ outcome: parsed.outcome },
		parsed.signed_at,
	);
	return memory.closeout(
		memory.db.prepare("SELECT * FROM terminal_closeouts WHERE closeout_id=?").get(parsed.closeout_id) as Record<
			string,
			unknown
		>,
	);
}

export function checkpoint(memory: TerminalWorkMemory, input: CheckpointInput): void {
	const parsed = memory.validateCheckpoint(input);
	memory.db
		.prepare(`INSERT INTO terminal_checkpoints
    (checkpoint_id,correlation_id,terminal_id,work_id,purpose,decision,failure_summary,verification_summary,next_step,created_at,checkpoint_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			parsed.checkpoint_id,
			parsed.correlation_id,
			parsed.terminal_id,
			parsed.work_id,
			parsed.purpose,
			parsed.decision,
			parsed.failure_summary,
			parsed.verification_summary,
			parsed.next_step,
			parsed.created_at,
			terminalDigest(parsed),
		);
	memory.audit("terminal_checkpoint", parsed.checkpoint_id, parsed.correlation_id, {}, parsed.created_at);
}

export function unresolvedFailures(memory: TerminalWorkMemory, limit = 100): readonly TerminalFailureView[] {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TerminalMemoryError("TERMINAL_LIMIT_INVALID");
	return memory
		.rows(
			memory.db
				.prepare(
					"SELECT * FROM terminal_failures WHERE status IN ('open','investigating') ORDER BY opened_at,failure_id LIMIT ?",
				)
				.all(limit),
		)
		.map((failure) => ({
			failure_id: String(failure.failure_id),
			terminal_id: String(failure.terminal_id),
			project_id: failure.project_id === null ? null : String(failure.project_id),
			status: String(failure.status) as TerminalFailureView["status"],
			severity: String(failure.severity) as TerminalFailureView["severity"],
			summary: String(failure.summary),
		}));
}

export function terminalContext(memory: TerminalWorkMemory, terminalId: string, limit = 50): TerminalContextView {
	const id = identifier(terminalId);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TerminalMemoryError("TERMINAL_LIMIT_INVALID");
	const sessions = memory
		.rows(memory.db.prepare("SELECT * FROM terminal_sessions WHERE terminal_id=? ORDER BY started_at DESC").all(id))
		.map(memory.toSession);
	if (sessions.length === 0) throw new TerminalMemoryError("TERMINAL_SESSION_NOT_FOUND");
	const events = memory.rows(
		memory.db
			.prepare(
				"SELECT event_id,sequence,kind,occurred_at,outcome,evidence_ref,correlation_id FROM terminal_events WHERE terminal_id=? ORDER BY occurred_at DESC LIMIT ?",
			)
			.all(id, limit),
	);
	return {
		terminal_id: id,
		sessions,
		events: events.map((event) => ({
			event_id: String(event.event_id),
			sequence: Number(event.sequence),
			kind: String(event.kind),
			occurred_at: String(event.occurred_at),
			outcome: String(event.outcome),
			evidence_ref: event.evidence_ref === null ? null : String(event.evidence_ref),
			correlation_id: String(event.correlation_id),
		})),
		failures: unresolvedFailures(memory, limit).filter((failure) => failure.terminal_id === id),
	};
}
