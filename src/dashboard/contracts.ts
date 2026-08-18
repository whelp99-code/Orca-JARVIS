import type { CapabilityFact } from "../capabilities.js";
import type { CommandApprovalReceipt } from "../control-plane.js";
import type { TeamProposalRequestV1, TeamWorkType } from "../team-proposal.js";

export const DASHBOARD_SCHEMA_VERSION = 1 as const;
export const TASK_INPUT_INVALID = "TASK_INPUT_INVALID" as const;
export const RECEIPT_DECISION_INVALID = "RECEIPT_DECISION_INVALID" as const;
export const REDACTED = "[REDACTED]" as const;

export const ID_LIMIT = 128;
export const OBJECTIVE_LIMIT = 4096;
export const FIELD_LIMIT = 512;
export const QUESTION_ID_LIMIT = 64;
export const LIST_LIMIT = 3;
export const SIGNATURE_LIMIT = 256;
export const MAX_STEPS_MIN = 1;
export const MAX_STEPS_MAX = 100;
export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 10;
export const OBJECT_DEPTH_LIMIT = 3;
export const OUTPUT_STRING_LIMIT = 10_000;

export const CREATE_TASK_KEYS = [
  "schema_version", "request_id", "nonce", "task_id", "run_id",
  "expected_proposal_digest", "proposal_request", "budget",
] as const;
export const BUDGET_KEYS = ["max_steps", "max_attempts_per_node", "deadline"] as const;
export const PROPOSAL_KEYS = [
  "schema_version", "objective", "work_type", "completion_evidence",
  "answers", "constraints", "requested_capabilities",
] as const;
export const ANSWER_KEYS = ["question_id", "answer"] as const;
export const RECEIPT_DECISION_KEYS = ["schema_version", "receipt"] as const;
export const EXECUTE_KEYS = ["schema_version"] as const;
export const CANCEL_KEYS = ["schema_version", "request_id", "nonce", "run_id", "reason"] as const;
export const RETRY_KEYS = ["schema_version", "request_id", "nonce"] as const;
export const RECEIPT_KEYS = [
  "schema_version", "receipt_id", "request_id", "decision", "command_digest",
  "signer_principal_id", "authenticated_session_id", "key_id", "algorithm",
  "issued_at", "not_before", "expires_at", "nonce", "max_uses", "status", "signature",
] as const;

export const QUESTION_IDS = ["work_type", "completion_evidence", "constraints"] as const;
export const WORK_TYPES = ["research", "development", "analysis", "content", "product"] as const satisfies readonly TeamWorkType[];
export const CAPABILITY_IDS = ["codex", "claude", "orca_read", "gjc", "live_resume"] as const satisfies ReadonlyArray<CapabilityFact["id"]>;
export const RECEIPT_DECISIONS = ["approve", "reject"] as const;
export const RECEIPT_ALGORITHM = "Ed25519" as const;
export const RECEIPT_STATUS = "issued" as const;
export const RECEIPT_MAX_USES = 1 as const;

export const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
export const RFC3339_MS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
export const SECRET_KEY_PATTERN = /token|secret|password|authorization|cookie|signature|private_key|receipt_json|session_id/i;
export const TERMINAL_SECRET_PATTERN = /(?:\/\/[^\s/@:]+:[^\s/@]+@|\b(?:Bearer|Basic)\s+\S+|\bAuthorization\s*[:=]|\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|[A-Za-z][A-Za-z0-9_]*_(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)|API_KEY)\b\s*=|--(?:client-secret|token|session-id|key-file)\b|\b(?:AKIA|ASIA)[A-Z0-9]{8,}|\b(?:sk-(?:proj-|ant-|live-|test-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export type Sha256Digest = `sha256:${string}`;
export type ProposalQuestionId = (typeof QUESTION_IDS)[number];
export type ReceiptDecision = (typeof RECEIPT_DECISIONS)[number];

export type TaskBudget = {
  readonly max_steps: number;
  readonly max_attempts_per_node: number;
  readonly deadline: string;
};

export type CreateTaskRequest = {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly nonce: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly expected_proposal_digest: Sha256Digest;
  readonly proposal_request: TeamProposalRequestV1;
  readonly budget: TaskBudget;
};

export type ReceiptDecisionRequest = {
  readonly schema_version: 1;
  readonly receipt: CommandApprovalReceipt;
};

export type ExecuteRequest = {
  readonly schema_version: 1;
};

export type CancelRequest = {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly nonce: string;
  readonly run_id: string;
  readonly reason: string;
};

export type RetryRequest = {
  readonly schema_version: 1;
  readonly request_id: string;
  readonly nonce: string;
};
