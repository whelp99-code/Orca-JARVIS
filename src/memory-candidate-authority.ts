import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { memoryDecisionBindingDigest } from "./memory-candidate-material.js";
import type { ParsedMemoryCandidateInput } from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";
import { isPersistenceRow, persistenceRow, persistenceText } from "./personal-persistence-values.js";

function containsBinding(value: unknown, binding: string): boolean {
  if (value === binding) return true;
  if (Array.isArray(value)) return value.some(item => containsBinding(item, binding));
  if (!isPersistenceRow(value)) return false;
  return Object.values(value).some(item => containsBinding(item, binding));
}

function parseStoredJson(value: unknown): unknown {
  const text = persistenceText(value);
  try {
    const parsed: unknown = JSON.parse(text);
    return canonicalize(parsed) === text ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function approvedMemoryDecisionIsCurrent(
  database: Database.Database,
  input: ParsedMemoryCandidateInput,
  now: Date,
): boolean {
  const source = input.source;
  if (source.input_class !== "approved_decision") return true;
  if (source.request_id === null || source.receipt_id === null || source.command_digest === null
    || source.principal_id === null || source.authenticated_session_id === null
    || source.issued_at === null || source.source_expires_at === null) return false;
  const value = database.prepare(
    `SELECT r.*,a.receipt_id,a.decision,a.command_digest AS receipt_command_digest,
      a.signer_principal_id,a.authenticated_session_id,a.issued_at,a.expires_at AS receipt_expires_at
     FROM control_command_requests r
     JOIN control_command_receipts a ON a.request_id=r.request_id
     WHERE r.request_id=? AND a.receipt_id=?`,
  ).get(source.request_id, source.receipt_id);
  if (value === undefined) return false;
  const row = persistenceRow(value);
  const target = parseStoredJson(row["target_json"]);
  const args = parseStoredJson(row["args_json"]);
  if (target === null || args === null) return false;
  const actionLevel = row["action_level"];
  if (typeof actionLevel !== "number" || !Number.isSafeInteger(actionLevel)
    || actionLevel < 0 || actionLevel > 5) return false;
  const commandDigest = memoryHash("", {
    schema_version: 1,
    request_id: source.request_id,
    action: row["action"],
    action_level: actionLevel,
    target,
    args,
    reversible: Boolean(row["reversible"]),
    requested_by: row["requested_by"],
    requested_at: row["requested_at"],
    expires_at: row["expires_at"],
    nonce: row["nonce"],
  });
  const allowedState = row["state"] === "approved" || row["state"] === "claimed" || row["state"] === "completed";
  const exact = allowedState
    && row["decision"] === "approve"
    && row["command_digest"] === source.command_digest
    && row["receipt_command_digest"] === source.command_digest
    && commandDigest === source.command_digest
    && row["requested_by"] === input.principal_id
    && row["signer_principal_id"] === source.principal_id
    && row["authenticated_session_id"] === source.authenticated_session_id
    && row["issued_at"] === source.issued_at
    && row["receipt_expires_at"] === source.source_expires_at
    && Date.parse(persistenceText(row["expires_at"])) > now.getTime()
    && Date.parse(persistenceText(row["receipt_expires_at"])) > now.getTime();
  if (!exact) return false;
  const revoked = database.prepare(
    `SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
     UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?) LIMIT 1`,
  ).get(source.request_id, source.receipt_id, source.request_id, source.receipt_id, source.command_digest);
  const binding = memoryDecisionBindingDigest(input);
  return revoked === undefined && (containsBinding(target, binding) || containsBinding(args, binding));
}
