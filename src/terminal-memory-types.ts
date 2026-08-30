export type TerminalHostId = "host:pos:linux-control-plane" | "host:pos:linux-second-brain" | "host:pos:mac-client" | "host:pos:phone-client";
export type TerminalStatus = "active" | "ended" | "unknown";
export type TerminalOutcome = "succeeded" | "failed" | "cancelled" | "timeout" | "uncertain" | "skipped";
export type TerminalEventKind = "command" | "test" | "build" | "git" | "agent" | "lifecycle" | "checkpoint";
export type FailureStatus = "open" | "investigating" | "resolved" | "accepted-risk" | "superseded" | "invalidated";
export type WorkOutcome = "success" | "partial" | "failed" | "cancelled" | "blocked" | "uncertain";
export type ResolutionSource = "task" | "dispatch" | "worktree" | "worker" | "git_remote" | "cwd" | "unassigned";
export type ResolutionConfidence = "confirmed" | "high" | "medium" | "low";

export type TerminalSessionInput = Readonly<{
	terminal_id: string;
	terminal_incarnation_id: string;
	host_id: TerminalHostId;
	environment_id: string;
	terminal_provider: string;
	started_at: string;
	primary_project_id?: string | null;
	created_by: string;
	correlation_id: string;
}>;

export type TerminalEventInput = Readonly<{
	event_id: string;
	terminal_id: string;
	terminal_incarnation_id: string;
	sequence: number;
	kind: TerminalEventKind;
	occurred_at: string;
	started_at?: string | null;
	finished_at?: string | null;
	duration_ms?: number | null;
	exit_code?: number | null;
	outcome: TerminalOutcome;
	command_class: string;
	command?: string;
	stdout?: string;
	stderr?: string;
	evidence_ref?: string | null;
	correlation_id: string;
}>;

export type ProjectSegmentInput = Readonly<{
	segment_id: string;
	terminal_id: string;
	terminal_incarnation_id: string;
	project_id: string;
	worktree_id?: string | null;
	cwd_digest: string;
	started_at: string;
	ended_at?: string | null;
	resolution_source: ResolutionSource;
	resolution_confidence: ResolutionConfidence;
}>;

export type FailureInput = Readonly<{
	failure_id: string;
	terminal_id: string;
	terminal_incarnation_id: string;
	project_id?: string | null;
	source_event_id: string;
	failure_class: string;
	summary: string;
	severity: "P0" | "P1" | "P2" | "P3";
}>;

export type ResolutionInput = Readonly<{
	resolution_id: string;
	failure_id: string;
	source_event_ids: readonly string[];
	summary: string;
	verification_id: string;
	verified_at: string;
	correlation_id: string;
}>;

export type CheckpointInput = Readonly<{
	checkpoint_id: string;
	correlation_id: string;
	terminal_id?: string | null;
	work_id?: string | null;
	purpose: string;
	decision: string;
	failure_summary?: string | null;
	verification_summary?: string | null;
	next_step?: string | null;
	created_at: string;
}>;

export type CloseoutInput = Readonly<{
	closeout_id: string;
	work_id: string;
	correlation_id: string;
	terminal_ids: readonly string[];
	project_ids: readonly string[];
	outcome: WorkOutcome;
	verified_result: readonly string[];
	failed_items: readonly string[];
	unresolved_items: readonly string[];
	artifacts: readonly string[];
	commit_refs: readonly string[];
	issue_refs: readonly string[];
	improvements: readonly string[];
	next_actions: readonly string[];
	signed_at: string;
}>;

export type TerminalSession = Readonly<TerminalSessionInput & { ended_at: string | null; status: TerminalStatus }>;
export type TerminalEvent = Readonly<
	TerminalEventInput & {
		command_digest: string;
		stdout_digest: string | null;
		stderr_digest: string | null;
		redaction_state: "redacted" | "digest_only";
	}
>;
export type TerminalFailure = Readonly<
	FailureInput & {
		status: FailureStatus;
		opened_at: string;
		resolved_at: string | null;
		resolution_id: string | null;
	}
>;
export type TerminalCloseout = Readonly<CloseoutInput & { canonical_digest: string }>;
