import { REMOTE_ALLOWED_ACTIONS } from "./remote-approval-types.js";

export class RemoteApprovalPolicyError extends Error {
  readonly name = "RemoteApprovalPolicyError";
  constructor() {
    super("PERSONAL_POLICY_INVALID");
  }
}

export type RemoteApprovalPolicy = Readonly<{
  schema_version: 1;
  allowed_actions: readonly typeof REMOTE_ALLOWED_ACTIONS[number][];
  max_action_level: 3;
  begin_ttl_seconds: 600;
  registration_ttl_seconds: 300;
  challenge_ttl_seconds: 300;
  activation_ttl_seconds: 600;
  pending_credential_ttl_seconds: 600;
  verification_reservation_ttl_seconds: 30;
  ingress_nonce_ttl_seconds: 30;
  audit_retention_days: 365;
  active_credential_cap: 5;
  pending_credential_cap: 2;
  live_registration_cap: 8;
  live_challenge_cap: 128;
  live_ingress_nonce_cap: 1024;
  counter_regression_policy: "reject_audit_local_owner_revoke";
  credential_tombstone_retention: "indefinite_security_identifier";
}>;

const KEYS = [
  "schema_version", "allowed_actions", "max_action_level", "begin_ttl_seconds", "registration_ttl_seconds",
  "challenge_ttl_seconds", "activation_ttl_seconds", "pending_credential_ttl_seconds",
  "verification_reservation_ttl_seconds", "ingress_nonce_ttl_seconds", "audit_retention_days",
  "active_credential_cap", "pending_credential_cap", "live_registration_cap", "live_challenge_cap",
  "live_ingress_nonce_cap", "counter_regression_policy", "credential_tombstone_retention",
] as const;

function invalid(): never { throw new RemoteApprovalPolicyError(); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  return value;
}
function exactInt(value: unknown, expected: number): number {
  if (!Number.isSafeInteger(value) || value !== expected) return invalid();
  return expected;
}

export function parseRemoteApprovalPolicy(value: unknown): RemoteApprovalPolicy {
  const input = record(value);
  const keys = Object.keys(input);
  if (keys.length !== KEYS.length || keys.some(key => !KEYS.includes(key as typeof KEYS[number]))) invalid();
  if (input.schema_version !== 1) invalid();
  if (!Array.isArray(input.allowed_actions) || input.allowed_actions.length !== REMOTE_ALLOWED_ACTIONS.length) invalid();
  const actions = input.allowed_actions.map(item => {
    if (typeof item !== "string") return invalid();
    const found = REMOTE_ALLOWED_ACTIONS.find(action => action === item);
    return found ?? invalid();
  });
  if (new Set(actions).size !== REMOTE_ALLOWED_ACTIONS.length) invalid();
  if (actions.some((action, index) => action !== REMOTE_ALLOWED_ACTIONS[index])) invalid();
  const parsed: RemoteApprovalPolicy = {
    schema_version: 1,
    allowed_actions: REMOTE_ALLOWED_ACTIONS,
    max_action_level: exactInt(input.max_action_level, 3) as 3,
    begin_ttl_seconds: exactInt(input.begin_ttl_seconds, 600) as 600,
    registration_ttl_seconds: exactInt(input.registration_ttl_seconds, 300) as 300,
    challenge_ttl_seconds: exactInt(input.challenge_ttl_seconds, 300) as 300,
    activation_ttl_seconds: exactInt(input.activation_ttl_seconds, 600) as 600,
    pending_credential_ttl_seconds: exactInt(input.pending_credential_ttl_seconds, 600) as 600,
    verification_reservation_ttl_seconds: exactInt(input.verification_reservation_ttl_seconds, 30) as 30,
    ingress_nonce_ttl_seconds: exactInt(input.ingress_nonce_ttl_seconds, 30) as 30,
    audit_retention_days: exactInt(input.audit_retention_days, 365) as 365,
    active_credential_cap: exactInt(input.active_credential_cap, 5) as 5,
    pending_credential_cap: exactInt(input.pending_credential_cap, 2) as 2,
    live_registration_cap: exactInt(input.live_registration_cap, 8) as 8,
    live_challenge_cap: exactInt(input.live_challenge_cap, 128) as 128,
    live_ingress_nonce_cap: exactInt(input.live_ingress_nonce_cap, 1024) as 1024,
    counter_regression_policy: input.counter_regression_policy === "reject_audit_local_owner_revoke"
      ? "reject_audit_local_owner_revoke" : invalid(),
    credential_tombstone_retention: input.credential_tombstone_retention === "indefinite_security_identifier"
      ? "indefinite_security_identifier" : invalid(),
  };
  if (parsed.registration_ttl_seconds > 300 || parsed.challenge_ttl_seconds > 300) invalid();
  if (parsed.verification_reservation_ttl_seconds >= parsed.challenge_ttl_seconds) invalid();
  if (parsed.pending_credential_ttl_seconds !== parsed.activation_ttl_seconds) invalid();
  return parsed;
}

export const FROZEN_REMOTE_APPROVAL_POLICY: RemoteApprovalPolicy = {
  schema_version: 1,
  allowed_actions: REMOTE_ALLOWED_ACTIONS,
  max_action_level: 3,
  begin_ttl_seconds: 600,
  registration_ttl_seconds: 300,
  challenge_ttl_seconds: 300,
  activation_ttl_seconds: 600,
  pending_credential_ttl_seconds: 600,
  verification_reservation_ttl_seconds: 30,
  ingress_nonce_ttl_seconds: 30,
  audit_retention_days: 365,
  active_credential_cap: 5,
  pending_credential_cap: 2,
  live_registration_cap: 8,
  live_challenge_cap: 128,
  live_ingress_nonce_cap: 1024,
  counter_regression_policy: "reject_audit_local_owner_revoke",
  credential_tombstone_retention: "indefinite_security_identifier",
};
