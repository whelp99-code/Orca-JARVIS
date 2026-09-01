import type { RuntimeControlActionInput } from "./control-actions.js";
import { JarvisError } from "./db.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function rejectUnexpected(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new JarvisError("CONTROL_TARGET_MISMATCH");
}
function requireString(value: Record<string, unknown>, key: string, code: string): string {
  const item = value[key];
  if (!nonempty(item)) throw new JarvisError(code);
  return item;
}
function requireSchema(args: Record<string, unknown>): void {
  if (args.schema_version !== 1) throw new JarvisError("CONTROL_ARGS_MISMATCH");
}

function begin(input: RuntimeControlActionInput): void {
  rejectUnexpected(input.target, ["principal_id", "user_handle_digest", "rp_id", "origin"]);
  rejectUnexpected(input.args, ["schema_version", "enrollment_id", "enrollment_nonce_digest"]);
  requireString(input.target, "principal_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "user_handle_digest", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "rp_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "origin", "CONTROL_TARGET_MISMATCH");
  requireSchema(input.args);
  requireString(input.args, "enrollment_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "enrollment_nonce_digest", "CONTROL_ARGS_MISMATCH");
}

function activate(input: RuntimeControlActionInput): void {
  rejectUnexpected(input.target, [
    "principal_id", "credential_id_digest", "public_key_digest", "user_handle_digest", "rp_id", "origin",
  ]);
  rejectUnexpected(input.args, [
    "schema_version", "enrollment_id", "registration_ceremony_id", "algorithm", "backup_eligible",
  ]);
  requireString(input.target, "principal_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "credential_id_digest", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "public_key_digest", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "user_handle_digest", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "rp_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "origin", "CONTROL_TARGET_MISMATCH");
  requireSchema(input.args);
  requireString(input.args, "enrollment_id", "CONTROL_ARGS_MISMATCH");
  requireString(input.args, "registration_ceremony_id", "CONTROL_ARGS_MISMATCH");
  if (input.args.algorithm !== -7 && input.args.algorithm !== -8) throw new JarvisError("CONTROL_ARGS_MISMATCH");
  if (input.args.backup_eligible !== 0 && input.args.backup_eligible !== 1) throw new JarvisError("CONTROL_ARGS_MISMATCH");
}

function revokeCredential(input: RuntimeControlActionInput): void {
  rejectUnexpected(input.target, ["principal_id", "credential_id_digest", "public_key_digest"]);
  rejectUnexpected(input.args, ["schema_version", "reason_digest"]);
  requireString(input.target, "principal_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "credential_id_digest", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "public_key_digest", "CONTROL_TARGET_MISMATCH");
  requireSchema(input.args);
  requireString(input.args, "reason_digest", "CONTROL_ARGS_MISMATCH");
}

function revokePrincipal(input: RuntimeControlActionInput): void {
  rejectUnexpected(input.target, ["principal_id", "user_handle_digest"]);
  rejectUnexpected(input.args, ["schema_version", "reason_digest"]);
  requireString(input.target, "principal_id", "CONTROL_TARGET_MISMATCH");
  requireString(input.target, "user_handle_digest", "CONTROL_TARGET_MISMATCH");
  requireSchema(input.args);
  requireString(input.args, "reason_digest", "CONTROL_ARGS_MISMATCH");
}

export const REMOTE_LIFECYCLE_ACTIONS = {
  "remote.credential.enroll.begin": {
    action: "remote.credential.enroll.begin", minimum_level: 3, executable: false, validate: begin,
  },
  "remote.credential.enroll.activate": {
    action: "remote.credential.enroll.activate", minimum_level: 3, executable: false, validate: activate,
  },
  "remote.credential.revoke": {
    action: "remote.credential.revoke", minimum_level: 3, executable: false, validate: revokeCredential,
  },
  "remote.principal.revoke": {
    action: "remote.principal.revoke", minimum_level: 4, executable: false, validate: revokePrincipal,
  },
} as const;

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
