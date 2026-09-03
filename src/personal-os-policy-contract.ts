import type { RemoteApprovalPolicy } from "./remote-approval-policy.js";

export const PURPOSES = [
  "personal_memory",
  "live_awareness",
  "owner_notification",
  "data_portability",
  "data_erasure",
  "vault_migration",
  "disaster_recovery",
] as const;
export const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
export const ACTIONS = ["memory", "observation", "notification", "export", "delete", "transfer", "restore"] as const;
export const HOSTS = ["linux-control-plane", "linux-second-brain"] as const;
export const CLIENT_HOSTS = ["mac-client", "phone-client"] as const;
export const PROHIBITED_FIELDS = ["secret", "raw_body", "raw_screen", "audio", "video"] as const;
export const NOTIFICATION_FIELDS = ["title", "summary", "alert_class", "deep_link"] as const;
export const CONFIRMATIONS = ["none", "sensitive", "exact"] as const;
export const PORTABILITY = ["allowed", "exact_confirmation", "prohibited"] as const;
export const MIGRATION = ["prohibited", "exact_gate"] as const;
export const PROJECTIONS = ["redacted", "metadata_only", "prohibited"] as const;
export const ORIGINS = ["trusted", "retrieved", "model"] as const;
export const CLASS_KEYS = [
  "purpose",
  "retention_days",
  "confirmation",
  "export",
  "deletion",
  "host_owner",
  "no_data",
  "transfer",
  "restore",
  "client_projection",
] as const;
export const EVALUATION_KEYS = [
  "action",
  "data_class",
  "principal_id",
  "purpose",
  "sensitivity",
  "host",
  "client_host",
  "observed_at",
  "fresh_until",
  "expires_at",
  "payload_fields",
  "alert_class",
  "no_data",
  "content_origin",
  "requests_policy_mutation",
  "requests_authority",
] as const;
export const EVALUATION_KEY_SET = new Set<string>(EVALUATION_KEYS);
export const CANONICAL_GATES = {
  mac_vault_transfer: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL",
  linux_restore: "SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL",
  export: "PERSONAL_DATA_EXPORT_APPROVAL",
  deletion: "PERSONAL_DATA_DELETE_APPROVAL",
  sensitive_memory: "PERSONAL_MEMORY_CONFIRMATION",
} as const;

export type Purpose = (typeof PURPOSES)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type Action = (typeof ACTIONS)[number];
export type Host = (typeof HOSTS)[number];
export type ClientHost = (typeof CLIENT_HOSTS)[number];
export type ContentOrigin = (typeof ORIGINS)[number];
export type DataClassPolicy = {
  readonly purpose: Purpose;
  readonly retention_days: number;
  readonly confirmation: (typeof CONFIRMATIONS)[number];
  readonly export: (typeof PORTABILITY)[number];
  readonly deletion: (typeof PORTABILITY)[number];
  readonly host_owner: Host;
  readonly no_data: "abstain";
  readonly transfer: (typeof MIGRATION)[number];
  readonly restore: (typeof MIGRATION)[number];
  readonly client_projection: (typeof PROJECTIONS)[number];
};
export type PersonalOsPolicy = {
  readonly schema_version: 1;
  readonly policy_id: string;
  readonly owner_principal: string;
  readonly authority_host: "linux-control-plane";
  readonly effective_at: string;
  readonly expires_at: string;
  readonly retention: { readonly max_days: number };
  readonly quiet_hours: { readonly start: string; readonly end: string; readonly critical_alert_classes: readonly string[] };
  readonly prohibited_fields: readonly string[];
  readonly notification_allowed_fields: readonly string[];
  readonly client_hosts: readonly ClientHost[];
  readonly gates: { readonly [Key in keyof typeof CANONICAL_GATES]: (typeof CANONICAL_GATES)[Key] };
  readonly data_classes: Readonly<Record<Action, DataClassPolicy>>;
  readonly remote_approval: RemoteApprovalPolicy;
};
export type EvaluationInput = {
  readonly action: Action;
  readonly data_class: Action;
  readonly principal_id: string;
  readonly purpose: Purpose;
  readonly sensitivity: Sensitivity;
  readonly host: Host;
  readonly client_host: ClientHost | null;
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly expires_at: string;
  readonly payload_fields: readonly string[];
  readonly alert_class: string | null;
  readonly no_data: boolean;
  readonly content_origin: ContentOrigin;
  readonly requests_policy_mutation: boolean;
  readonly requests_authority: boolean;
};
export type PersonalPolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "require_confirmation"; readonly gate_id: string }
  | { readonly kind: "redact"; readonly fields: readonly string[] }
  | { readonly kind: "abstain"; readonly reason: string };
