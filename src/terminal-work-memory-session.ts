import type {
	ProjectSegmentInput,
	TerminalEvent,
	TerminalEventInput,
	TerminalSession,
	TerminalSessionInput,
} from "./terminal-memory-types.js";
import {
	boundedEvidence,
	eventKind,
	identifier,
	optionalText,
	outcome,
	terminalDigest,
	text,
	timestamp,
	TerminalMemoryError,
} from "./terminal-memory-validation.js";
import type { TerminalWorkMemory } from "./terminal-work-memory.js";

export function startSession(
	memory: TerminalWorkMemory,
	input: TerminalSessionInput,
): TerminalSession {
	const parsed = memory.validateSession(input);
	const values: Record<string, unknown> = { ...parsed };
	const existing = memory.lookupSession(parsed.terminal_id, parsed.terminal_incarnation_id);
	if (existing !== undefined) {
		const keys = [
			"terminal_id",
			"terminal_incarnation_id",
			"host_id",
			"environment_id",
			"terminal_provider",
			"started_at",
			"primary_project_id",
			"created_by",
			"correlation_id",
		];
		if (!keys.every((key) => (existing[key] ?? null) === (values[key] ?? null)))
			throw new TerminalMemoryError("TERMINAL_SESSION_CONFLICT");
		return memory.toSession(existing);
	}
	memory.db
		.prepare(`INSERT INTO terminal_sessions
    (terminal_id,terminal_incarnation_id,host_id,environment_id,terminal_provider,started_at,ended_at,status,primary_project_id,created_by,correlation_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			parsed.terminal_id,
			parsed.terminal_incarnation_id,
			parsed.host_id,
			parsed.environment_id,
			parsed.terminal_provider,
			parsed.started_at,
			null,
			"active",
			parsed.primary_project_id ?? null,
			parsed.created_by,
			parsed.correlation_id,
		);
	memory.audit(
		"terminal_session",
		parsed.terminal_id,
		parsed.correlation_id,
		{ state: "active" },
		parsed.started_at,
	);
	return memory.toSession(
		memory.lookupSession(parsed.terminal_id, parsed.terminal_incarnation_id)!,
	);
}

export function endSession(
	memory: TerminalWorkMemory,
	terminalId: string,
	incarnationId: string,
	endedAt: string,
): TerminalSession {
	const id = identifier(terminalId);
	const incarnation = identifier(incarnationId);
	const ended = timestamp(endedAt);
	const current = memory.lookupSession(id, incarnation);
	if (current === undefined) throw new TerminalMemoryError("TERMINAL_SESSION_NOT_FOUND");
	if (current.status === "ended") return memory.toSession(current);
	if (Date.parse(ended) < Date.parse(String(current.started_at)))
		throw new TerminalMemoryError("TERMINAL_TIME_ORDER_INVALID");
	memory.db
		.prepare(
			"UPDATE terminal_sessions SET ended_at=?,status='ended' WHERE terminal_id=? AND terminal_incarnation_id=? AND status='active'",
		)
		.run(ended, id, incarnation);
	memory.audit("terminal_session", id, String(current.correlation_id), { state: "ended" }, ended);
	return memory.toSession(memory.lookupSession(id, incarnation)!);
}

export function recordSegment(memory: TerminalWorkMemory, input: ProjectSegmentInput): void {
	const session = memory.requireSession(input.terminal_id, input.terminal_incarnation_id);
	const project = identifier(input.project_id);
	const segment = identifier(input.segment_id);
	const started = timestamp(input.started_at);
	const ended =
		input.ended_at === null || input.ended_at === undefined ? null : timestamp(input.ended_at);
	if (ended !== null && Date.parse(ended) < Date.parse(started))
		throw new TerminalMemoryError("TERMINAL_TIME_ORDER_INVALID");
	const sources = [
		"task",
		"dispatch",
		"worktree",
		"worker",
		"git_remote",
		"cwd",
		"unassigned",
	] as const;
	const confidence = ["confirmed", "high", "medium", "low"] as const;
	if (
		!sources.includes(input.resolution_source) ||
		!confidence.includes(input.resolution_confidence)
	)
		throw new TerminalMemoryError("TERMINAL_PROJECT_RESOLUTION_INVALID");
	memory.db
		.prepare(`INSERT INTO terminal_project_segments
    (segment_id,terminal_id,terminal_incarnation_id,project_id,worktree_id,cwd_digest,started_at,ended_at,resolution_source,resolution_confidence)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
		.run(
			segment,
			session.terminal_id,
			session.terminal_incarnation_id,
			project,
			optionalText(input.worktree_id, 512),
			text(input.cwd_digest, 256),
			started,
			ended,
			input.resolution_source,
			input.resolution_confidence,
		);
}

export function recordEvent(memory: TerminalWorkMemory, input: TerminalEventInput): TerminalEvent {
	const session = memory.requireSession(input.terminal_id, input.terminal_incarnation_id);
	const eventId = identifier(input.event_id);
	const kind = eventKind(input.kind);
	const occurred = timestamp(input.occurred_at);
	const result = outcome(input.outcome);
	const command = boundedEvidence(input.command);
	const stdout = boundedEvidence(input.stdout);
	const stderr = boundedEvidence(input.stderr);
	const started =
		input.started_at === null || input.started_at === undefined
			? null
			: timestamp(input.started_at);
	const finished =
		input.finished_at === null || input.finished_at === undefined
			? null
			: timestamp(input.finished_at);
	if (
		(started !== null && Date.parse(started) > Date.parse(occurred)) ||
		(finished !== null && started !== null && Date.parse(finished) < Date.parse(started))
	)
		throw new TerminalMemoryError("TERMINAL_TIME_ORDER_INVALID");
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
		throw new TerminalMemoryError("TERMINAL_SEQUENCE_INVALID");
	const prior = memory.db
		.prepare(
			"SELECT sequence FROM terminal_events WHERE terminal_id=? AND terminal_incarnation_id=? ORDER BY sequence DESC LIMIT 1",
		)
		.get(session.terminal_id, session.terminal_incarnation_id) as { sequence: number } | undefined;
	if (prior !== undefined && Number(prior.sequence) + 1 !== input.sequence)
		throw new TerminalMemoryError("TERMINAL_SEQUENCE_CONFLICT");
	const commandDigest = terminalDigest(command ?? "");
	const stdoutDigest = stdout === null ? null : terminalDigest(stdout);
	const stderrDigest = stderr === null ? null : terminalDigest(stderr);
	memory.db
		.prepare(`INSERT INTO terminal_events
    (event_id,terminal_id,terminal_incarnation_id,sequence,kind,occurred_at,started_at,finished_at,duration_ms,exit_code,outcome,
     command_class,command_digest,stdout_digest,stderr_digest,evidence_ref,redaction_state,correlation_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
		.run(
			eventId,
			session.terminal_id,
			session.terminal_incarnation_id,
			input.sequence,
			kind,
			occurred,
			started,
			finished,
			input.duration_ms ?? null,
			input.exit_code ?? null,
			result,
			text(input.command_class, 64),
			commandDigest,
			stdoutDigest,
			stderrDigest,
			optionalText(input.evidence_ref, 512),
			"digest_only",
			text(input.correlation_id, 256),
		);
	memory.audit(
		"terminal_event",
		eventId,
		input.correlation_id,
		{ sequence: input.sequence, outcome: result },
		occurred,
	);
	return memory.event(eventId);
}
