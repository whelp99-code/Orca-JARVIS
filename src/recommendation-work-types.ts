export type SignedDispatchReceipt = {
  readonly schema_version: 1; readonly receipt_id: string; readonly runtime_id: string;
  readonly intent_id: string; readonly attempt_id: string; readonly task_id: string;
  readonly idempotency_key: string; readonly provider: "codex" | "claude";
  readonly worktree_id: string; readonly terminal_id: string; readonly session_id: string;
  readonly incarnation_id: string; readonly pty_id: string; readonly accepted_at: string;
  readonly key_id: string; readonly algorithm: "Ed25519"; readonly signature: string;
};
export type DispatchReceipt = SignedDispatchReceipt;
export type DispatchIntent = {
  readonly runtime_id: string; readonly intent_id: string; readonly attempt_id: string;
  readonly task_id: string; readonly run_id: string; readonly workflow_digest: string;
  readonly idempotency_key: string;
};
export type DispatchOutcome =
  | { readonly kind: "accepted"; readonly receipt: SignedDispatchReceipt }
  | { readonly kind: "not_sent"; readonly reason: string }
  | { readonly kind: "uncertain"; readonly reason: string };
export interface DispatchAdapter {
  subscribe(intent: DispatchIntent): Promise<{ readonly event_id: string }>;
  trigger(intent: DispatchIntent): Promise<DispatchOutcome>;
}
export type WorkLease = {
  readonly runtime_id: string; readonly owner: string; readonly fence: number;
  readonly expires_at: string;
};
export type PreparedRecommendationWork = {
  readonly runtime_id: string; readonly request_id: string; readonly run_id: string;
  readonly workflow_digest: string; readonly dispatch_intent_id: string;
  readonly verification_request_id: string; readonly state: string;
};
export type RecommendationCompletion = {
  readonly schema_version: 1; readonly source: "recommendation_worker";
  readonly runtime_id: string; readonly dispatch_receipt_id: string;
  readonly dispatch_receipt_digest: string; readonly provider: "codex" | "claude";
  readonly worktree_id: string; readonly terminal_id: string; readonly session_id: string;
  readonly incarnation_id: string; readonly pty_id: string; readonly cursor: string;
  readonly sequence: string; readonly state: "completed"; readonly observed_at: string;
  readonly commit_digest: string; readonly artifact_digest: string; readonly test_digest: string;
  readonly evidence_digest: string; readonly event_id: string; readonly key_id: string;
  readonly algorithm: "Ed25519"; readonly signature: string;
};
export type RecommendationVerificationReceipt = {
  readonly schema_version: 1; readonly receipt_id: string;
  readonly verification_request_id: string; readonly request_digest: string;
  readonly runtime_id: string; readonly run_id: string; readonly workflow_digest: string;
  readonly dispatch_receipt_id: string; readonly commit_digest: string;
  readonly incarnation_id: string; readonly artifact_digest: string; readonly test_digest: string;
  readonly evidence_digest: string; readonly decision: "PASS" | "REJECT";
  readonly verifier_principal_id: string; readonly verifier_session_id: string;
  readonly verifier_incarnation_id: string; readonly key_id: string;
  readonly algorithm: "Ed25519"; readonly issued_at: string; readonly signature: string;
};
export type PendingRecommendationCancellation = {
  readonly cancel_id: string; readonly runtime_id: string; readonly state: "cancellation_pending";
  readonly reason: string;
};
export type RecommendationWorkSettlement = {
  readonly settlement_id: string; readonly runtime_id: string;
  readonly state: "completed" | "failed" | "cancelled";
  readonly candidate: Readonly<Record<string, unknown>> | null;
};
export type RecommendationCancellationResult = RecommendationWorkSettlement | PendingRecommendationCancellation;
