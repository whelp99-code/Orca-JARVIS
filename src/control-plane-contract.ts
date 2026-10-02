import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { base64url, unbase64url } from "./receipt.js";

export type ActionLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type ControlCommandState = "pending" | "approved" | "rejected" | "claimed" | "completed" | "failed" | "uncertain" | "cancelled";

export interface ControlCommandRequestInput {
  schema_version: 1;
  request_id: string;
  action: string;
  action_level: ActionLevel;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
  reversible: boolean;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  nonce: string;
}

export interface StoredControlCommand extends ControlCommandRequestInput {
  command_digest: string;
  state: ControlCommandState;
}

export interface CommandApprovalReceipt {
  schema_version: 1;
  receipt_id: string;
  request_id: string;
  decision: "approve" | "reject";
  command_digest: string;
  signer_principal_id: string;
  authenticated_session_id: string;
  key_id: string;
  algorithm: "Ed25519";
  issued_at: string;
  not_before: string;
  expires_at: string;
  nonce: string;
  max_uses: 1;
  status: "issued";
  signature: string;
}

export interface ClaimedControlCommand {
  request_id: string;
  receipt_id: string;
  action: string;
  action_level: ActionLevel;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
  command_digest: string;
  reversible: boolean;
  fence: number;
  lease_expires_at: string;
}

export interface ControlCancelInput {
  request_id: string;
  reason: string;
  actor?: string;
  revoked_by?: string;
  revoked_at: string;
}

export interface ControlEventInput {
  event_id: string;
  event_type: string;
  source: string;
  subject: string;
  correlation_id?: string;
  causation_id?: string;
  payload: unknown;
  created_at?: string;
}

export const COMMAND_APPROVAL_DOMAIN = "orca-jarvis/command-approval/v1\u0000";

export function controlValueDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : canonicalize(value))
    .digest("hex")}`;
}

export function isNonemptyControlValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isControlRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function controlCommandDigest(input: ControlCommandRequestInput): string {
  return controlValueDigest({
    schema_version: input.schema_version,
    request_id: input.request_id,
    action: input.action,
    action_level: input.action_level,
    target: input.target,
    args: input.args,
    reversible: input.reversible,
    requested_by: input.requested_by,
    requested_at: input.requested_at,
    expires_at: input.expires_at,
    nonce: input.nonce,
  });
}

export function signCommandApproval(payload: Omit<CommandApprovalReceipt, "signature">, key: KeyObject): CommandApprovalReceipt {
  const signature = sign(null, Buffer.from(COMMAND_APPROVAL_DOMAIN + canonicalize(payload)), key);
  return { ...payload, signature: base64url(signature) };
}

export function verifyCommandApproval(receipt: CommandApprovalReceipt, trustedPublicKey: string, now: Date, action?: string): boolean {
  const issued = Date.parse(receipt.issued_at);
  const notBefore = Date.parse(receipt.not_before);
  const expires = Date.parse(receipt.expires_at);
  if (
    receipt.schema_version !== 1 ||
    !isNonemptyControlValue(receipt.receipt_id) ||
    !isNonemptyControlValue(receipt.request_id) ||
    !isNonemptyControlValue(receipt.command_digest) ||
    !isNonemptyControlValue(receipt.signer_principal_id) ||
    !isNonemptyControlValue(receipt.authenticated_session_id) ||
    !isNonemptyControlValue(receipt.key_id) ||
    receipt.algorithm !== "Ed25519" ||
    receipt.max_uses !== 1 ||
    receipt.status !== "issued" ||
    !isNonemptyControlValue(receipt.nonce) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(notBefore) ||
    !Number.isFinite(expires) ||
    issued > now.getTime() ||
    notBefore > now.getTime() ||
    expires <= issued ||
    expires <= now.getTime() ||
    expires - issued > (action === "external.delegate" ? 30 : 15) * 60_000
  )
    return false;
  const payload: Omit<CommandApprovalReceipt, "signature"> = {
    schema_version: receipt.schema_version,
    receipt_id: receipt.receipt_id,
    request_id: receipt.request_id,
    decision: receipt.decision,
    command_digest: receipt.command_digest,
    signer_principal_id: receipt.signer_principal_id,
    authenticated_session_id: receipt.authenticated_session_id,
    key_id: receipt.key_id,
    algorithm: receipt.algorithm,
    issued_at: receipt.issued_at,
    not_before: receipt.not_before,
    expires_at: receipt.expires_at,
    nonce: receipt.nonce,
    max_uses: receipt.max_uses,
    status: receipt.status,
  };
  try {
    return verify(null, Buffer.from(COMMAND_APPROVAL_DOMAIN + canonicalize(payload)), trustedPublicKey, unbase64url(receipt.signature));
  } catch {
    return false;
  }
}
