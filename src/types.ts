export type TargetKind = "codex" | "claude";
export type Authorization = "code" | "human" | "both";
export type WorkState = "observed" | "candidate" | "guard_passed" | "blocked" | "awaiting_decision" | "continued" | "awaiting_verification" | "shadow_completed" | "rejected";

export interface CensusWork {
  id: string; proposal_hash: string; status: string; kind: string; authorization: Authorization;
  baseline: string; policy_hash: string; action: string; scope: unknown;
  forbidden_actions: string[]; budget: { max_tokens: number }; expected_effect: string; reversible: boolean; attempt_id: string;
  deadline: string; lease: { id: string; epoch: number; fencing_token: number; valid?: boolean };
  repo_id: string; worktree_id: string; terminal_kind: string; terminal_session_id: string; census_run_id: string;
  verify_allowlist: Array<{ argv: string[]; cwd: string; expected_exit: 0 }>;
}
export interface CensusSnapshot { version: number; project_id: string; target_kind: string; baseline: string; policy_hash: string; observed_at: string; work: CensusWork[] }
export interface GuardBindings { snapshot_digest: string; baseline: string; policy_hash: string; action: string; scope: unknown; forbidden_actions: string[]; budget: { max_tokens: number }; attempt_id: string; deadline: string; lease: { id: string; epoch: number; fencing_token: number } }
export interface DecisionReceipt { schema_version: 1; receipt_id: string; decision: "approve" | "reject"; proposal_hash: string; signer_principal_id: string; authenticated_session_id: string; key_id: string; algorithm: "Ed25519"; project_id: string; repo_id: string; worktree_id: string; terminal_kind: string; terminal_session_id: string; census_run_id: string; census_item_id: string; snapshot_digest: string; attempt_id: string; action_digest: string; scope_digest: string; forbidden_actions: string[]; forbidden_digest: string; policy_hash: string; budget_digest: string; expected_effect: string; reversible: boolean; issued_at: string; not_before: string; expires_at: string; nonce: string; max_uses: 1; status: "issued"; signature: string }
export interface PolicyAuthorization { schema_version: 1; authorization_id: string; proposal_hash: string; key_id: string; algorithm: "Ed25519"; project_id: string; repo_id: string; worktree_id: string; terminal_kind: string; terminal_session_id: string; census_run_id: string; census_item_id: string; snapshot_digest: string; attempt_id: string; action_digest: string; scope_digest: string; forbidden_digest: string; policy_hash: string; budget_digest: string; deadline: string; lease_epoch: number; fencing_token: number; issued_at: string; not_before: string; expires_at: string; nonce: string; max_uses: 1; status: "issued"; signature: string }
export interface VerificationEvidence { schema_version: 1; evidence_id: string; work_id: string; attempt_id: string; snapshot_digest: string; action_digest: string; policy_hash: string; scope_digest: string; lease_epoch: number; fencing_token: number; argv: string[]; cwd: string; expected_exit: 0; actual_exit: 0; issued_at: string; signer_key_id: string; signature: string }
export interface ContinuationInput extends GuardBindings { work_id: string; receipt?: DecisionReceipt; policy_authorization_id?: string; now?: string }

export type OrcaProvider = "codex" | "claude";
export type ProgressState = "running" | "needs_input" | "approval_required" | "verifying" | "stopped" | "unknown";
export interface ProgressAssessment { provider: OrcaProvider; terminal_id: string; incarnation_id: string; cursor: string | null; observation_identity: string; state: ProgressState; }
export interface ProgressBatch { version: 1; worktree: string; observed_at: string; assessments: ProgressAssessment[]; }
export interface ProgressTransition { provider: OrcaProvider; terminal_id: string; incarnation_id: string; cursor: string | null; from: ProgressState | null; to: ProgressState; }
export interface ProgressTransitionEvidence extends ProgressTransition { observation_identity: string; }
export interface StoredProgressReport { sequence: number; report_id: string; worktree: string; payload_json: string; payload_digest: string; created_at: string; }
export interface OrcaObservationSource {
  worktree: string; terminal_handle: string; provider: OrcaProvider; incarnation_id: string; next_cursor: string | null;
}
export interface OrcaObservationDelta {
  identity: string; worktree: string; terminal_handle: string; provider: OrcaProvider; incarnation_id: string;
  cursor_before: string | null; cursor_after: string | null; tail: string[]; truncated: boolean; limited: boolean;
  oldest_cursor: string | null; latest_cursor: string | null; returned_line_count: number; observed_at: string;
}

export type ProgressSignalProvider = "codex" | "claude";
/** A stopped state is valid only when it is explicitly provider-signed. */
export type ProgressSignalState = "running" | "needs_input" | "approval_required" | "verifying" | "stopped";
export type ProgressReasonCode =
  | "codex_exec_approval" | "codex_file_change_approval" | "codex_permission_escalation"
  | "codex_user_input_request" | "codex_elicitation" | "codex_turn_active" | "codex_tool_active"
  | "claude_permission_request" | "claude_plan_approval" | "claude_user_question" | "claude_elicitation"
  | "claude_turn_active" | "claude_tool_active" | "jarvis_canonical_verify_active" | "jarvis_canonical_final_stopped"
  | "terminal_disconnected" | "no_trusted_signal" | "incomplete_capture" | "ambiguous_evidence"
  | "stale_evidence" | "invalid_signal";

export interface ProgressSignal {
  schema_version: 1;
  source: "provider_bridge";
  provider: ProgressSignalProvider;
  terminal_id: string;
  incarnation_id: string;
  cursor: string | null;
  sequence: string;
  state: ProgressSignalState;
  reason_code: ProgressReasonCode;
  active: true;
  observed_at: string;
  event_id: string;
  key_id: string;
  algorithm: "Ed25519";
  signature: string;
}

export interface ProgressSignalKey {
  key_id: string;
  purpose: "progress-signal";
  provider: ProgressSignalProvider;
  public_key_pem: string;
  active: true;
  not_before: string;
  expires_at: string;
}

export interface ProgressEvidenceInput {
  provider: ProgressSignalProvider;
  terminal_id: string;
  incarnation_id: string;
  cursor: string | null;
  connected: boolean;
  capture_complete: boolean;
  observed_at: string;
  now: Date;
  signals: readonly unknown[];
  trusted_keys: readonly ProgressSignalKey[];
}

export interface ProgressClassification {
  provider: ProgressSignalProvider;
  terminal_id: string;
  incarnation_id: string;
  cursor: string | null;
  state: ProgressState;
  reason_code: ProgressReasonCode;
  observed_at: string;
  signal_event_id: string | null;
  sequence: string | null;
}
