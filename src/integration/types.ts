export const CORE5_INTEGRATION_CAPABILITIES = Object.freeze([
  "mail.read",
  "mail.draft",
  "mail.status",
  "cwos.command",
  "cwos.state",
  "memory.request",
  "memory.status",
  "memory.read",
] as const);

export type Core5IntegrationCapability = (typeof CORE5_INTEGRATION_CAPABILITIES)[number];

export const EXECUTION_STATUSES = Object.freeze([
  "SUCCESS",
  "FAIL",
  "TIMEOUT",
  "UNCERTAIN",
  "CANCELLED",
  "CANCELLED_AFTER_POSSIBLE_EFFECT",
] as const);

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type EvidenceRef = {
  readonly kind: string;
  readonly digest: string;
  readonly uri?: string;
};

export type ApprovalRef = {
  readonly approval_id: string;
  readonly digest: string;
  readonly issued_at?: string;
};

export type VerifiedCallerContext = {
  readonly principal: string;
  readonly workspace: string;
  readonly purpose: string;
  readonly expiry: string;
  readonly audience: string;
};

export type CommandEnvelope = {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly lease_fence: string;
  readonly capability: Core5IntegrationCapability;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly caller: VerifiedCallerContext;
  readonly evidence_refs?: readonly EvidenceRef[];
  readonly approval_ref?: ApprovalRef;
};

export type ExecutionResult = {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly lease_fence: string;
  readonly status: ExecutionStatus;
  readonly evidence_refs?: readonly EvidenceRef[];
  readonly error_code?: string;
};

export const CORE5_INTEGRATION_AUDIENCE = "jarvis.integration";
