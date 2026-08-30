import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import {
  controlCommandDigest,
  verifyCommandApproval,
  type ActionLevel,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
} from "./control-plane.js";
import { validateControlAction } from "./control-actions.js";
import type { MemoryAuthorityResolverInput, ResolvedMemoryAuthority } from "./memory-candidate-authority-types.js";
import { MEMORY_CANDIDATE_DIGEST_DOMAINS, type MemoryCandidateSourceMetadata } from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";

const RECEIPT_KEYS = [
  "schema_version", "receipt_id", "request_id", "decision", "command_digest", "signer_principal_id",
  "authenticated_session_id", "key_id", "algorithm", "issued_at", "not_before", "expires_at", "nonce",
  "max_uses", "status", "signature",
] as const;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
}

function parsedJson(value: unknown): Row | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = record(JSON.parse(value));
    return parsed && canonicalize(parsed) === value ? parsed : null;
  } catch { return null; }
}

function exact(value: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function finite(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function receiptFrom(value: Row): CommandApprovalReceipt | null {
  const strings = RECEIPT_KEYS.filter(key => !["schema_version", "max_uses"].includes(key));
  if (!exact(value, RECEIPT_KEYS) || value["schema_version"] !== 1 || value["max_uses"] !== 1
    || !strings.every(key => typeof value[key] === "string")
    || (value["decision"] !== "approve" && value["decision"] !== "reject")
    || value["algorithm"] !== "Ed25519" || value["status"] !== "issued") return null;
  return {
    schema_version: 1,
    receipt_id: String(value["receipt_id"]),
    request_id: String(value["request_id"]),
    decision: value["decision"],
    command_digest: String(value["command_digest"]),
    signer_principal_id: String(value["signer_principal_id"]),
    authenticated_session_id: String(value["authenticated_session_id"]),
    key_id: String(value["key_id"]),
    algorithm: "Ed25519",
    issued_at: String(value["issued_at"]),
    not_before: String(value["not_before"]),
    expires_at: String(value["expires_at"]),
    nonce: String(value["nonce"]),
    max_uses: 1,
    status: "issued",
    signature: String(value["signature"]),
  };
}

function requestFrom(row: Row, target: Row, args: Row): ControlCommandRequestInput | null {
  const actionLevel = Number(row["action_level"]);
  if (row["action"] === undefined || !Number.isSafeInteger(actionLevel) || (row["reversible"] !== 0 && row["reversible"] !== 1)) return null;
  return {
    schema_version: 1,
    request_id: String(row["request_id"]),
    action: String(row["action"]),
    action_level: actionLevel as ActionLevel,
    target,
    args,
    reversible: row["reversible"] === 1,
    requested_by: String(row["requested_by"]),
    requested_at: String(row["requested_at"]),
    expires_at: String(row["expires_at"]),
    nonce: String(row["nonce"]),
  };
}

function expectedArgs(context: MemoryAuthorityResolverInput, identityKey: string, identityValue: unknown): Row {
  const { input, identity } = context;
  return {
    schema_version: 1,
    candidate_id: identity.candidate_id,
    correlation_id: identity.correlation_id,
    subject_digest: identity.subject_digest,
    content_digest: identity.content_digest,
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    operation: input.operation,
    purpose: input.purpose,
    sensitivity: input.sensitivity,
    [identityKey]: identityValue,
  };
}

function revoked(database: Database.Database, row: Row, receipt: CommandApprovalReceipt): boolean {
  return database.prepare(
    `SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?
     UNION ALL SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?,?) LIMIT 1`,
  ).get(
    receipt.request_id,
    receipt.receipt_id,
    receipt.request_id,
    receipt.receipt_id,
    receipt.command_digest,
    receipt.key_id,
    receipt.nonce,
    receipt.signature,
  ) !== undefined || row["state"] !== "approved";
}

export function resolveControlMemoryAuthority(
  database: Database.Database,
  context: MemoryAuthorityResolverInput,
): ResolvedMemoryAuthority | null {
  const { input, identity, now } = context;
  const source = input.source;
  if ((source.input_class !== "explicit_user_instruction" && source.input_class !== "approved_decision")
    || source.request_id === null || source.receipt_id === null) return null;
  const row = database.prepare(
    `SELECT r.*,a.receipt_id,a.decision,a.command_digest AS receipt_command_digest,a.signer_principal_id,
      a.authenticated_session_id,a.key_id,a.payload_json AS receipt_payload_json,a.signature,a.issued_at,
      a.expires_at AS receipt_expires_at,k.public_key_pem,k.principal_id AS key_principal,p.purpose AS key_purpose
     FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id
     JOIN trusted_authority_keys k ON k.key_id=a.key_id JOIN authority_key_purposes p ON p.key_id=k.key_id
     WHERE r.request_id=? AND a.receipt_id=?`,
  ).get(source.request_id, source.receipt_id) as Row | undefined;
  if (!row) return null;
  const target = parsedJson(row["target_json"]);
  const args = parsedJson(row["args_json"]);
  const receiptValue = parsedJson(row["receipt_payload_json"]);
  if (!target || !args || !receiptValue) return null;
  const receipt = receiptFrom(receiptValue);
  const request = requestFrom(row, target, args);
  if (!receipt || !request) return null;
  const explicit = source.input_class === "explicit_user_instruction";
  const action = explicit ? "memory.instruction.record" : "memory.decision.record";
  const identityKey = explicit ? "instruction_id" : "decision_id";
  const identityValue = args[identityKey];
  const expires = Math.min(finite(request.expires_at), finite(receipt.expires_at));
  const exactRows = row["receipt_id"] === receipt.receipt_id && row["decision"] === receipt.decision
    && row["receipt_command_digest"] === receipt.command_digest && row["signer_principal_id"] === receipt.signer_principal_id
    && row["authenticated_session_id"] === receipt.authenticated_session_id && row["key_id"] === receipt.key_id
    && row["signature"] === receipt.signature && row["issued_at"] === receipt.issued_at
    && row["receipt_expires_at"] === receipt.expires_at;
  let actionValid = true;
  try { validateControlAction({ action: request.action, action_level: request.action_level, target, args }, { enforceMinimumLevel: true }); }
  catch { actionValid = false; }
  const valid = exactRows && actionValid && request.action === action && request.action_level === 3 && !request.reversible
    && request.request_id === receipt.request_id && request.request_id === source.request_id
    && receipt.receipt_id === source.receipt_id && receipt.decision === "approve"
    && request.requested_by === input.principal_id && receipt.signer_principal_id === input.principal_id
    && row["key_principal"] === input.principal_id && row["key_purpose"] === "decision"
    && controlCommandDigest(request) === row["command_digest"] && receipt.command_digest === row["command_digest"]
    && canonicalize(target) === canonicalize({ candidate_id: identity.candidate_id, correlation_id: identity.correlation_id })
    && canonicalize(args) === canonicalize(expectedArgs(context, identityKey, identityValue))
    && typeof identityValue === "string" && OPAQUE.test(identityValue)
    && finite(request.requested_at) <= now.getTime() && finite(receipt.issued_at) >= finite(request.requested_at)
    && Number.isFinite(expires) && expires > now.getTime() && finite(receipt.expires_at) <= finite(request.expires_at)
    && verifyCommandApproval(receipt, String(row["public_key_pem"]), now)
    && !revoked(database, row, receipt)
    && database.prepare("SELECT 1 FROM control_command_redemptions WHERE request_id=?").get(source.request_id) === undefined;
  if (!valid) return null;
  const authorityExpiry = new Date(expires).toISOString();
  const metadata: MemoryCandidateSourceMetadata = {
    source_id: source.source_id, source_version: source.source_version, principal_id: input.principal_id,
    authenticated_session_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.session, receipt.authenticated_session_id),
    worker_id: null, worker_session_digest: null, verifier_id: null,
    instruction_id: explicit ? String(identityValue) : null, outcome_id: explicit ? null : String(identityValue), attempt_id: null,
    verification_evidence_id: null, request_id: source.request_id, receipt_id: source.receipt_id,
    command_digest: receipt.command_digest, authority_key_id: receipt.key_id, authority_expires_at: authorityExpiry,
    inference_id: null, inference_label: null,
  };
  const observed = receipt.issued_at;
  const authorityDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, receipt);
  return {
    valid: true,
    source: metadata,
    references: [{
      kind: explicit ? "owner_instruction" : "verification",
      identifier: {
        namespace: "control_command",
        id: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, { kind: "request", id: source.request_id }).slice(7),
        version: 1,
      },
      evidence_digest: receipt.command_digest, observed_at: observed, fresh_until: authorityExpiry, expires_at: authorityExpiry,
    }, {
      kind: explicit ? "owner_session" : "artifact",
      identifier: {
        namespace: "control_receipt",
        id: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, { kind: "receipt", id: source.receipt_id }).slice(7),
        version: 1,
      },
      evidence_digest: authorityDigest, observed_at: observed, fresh_until: authorityExpiry, expires_at: authorityExpiry,
    }],
    claim: { authority_kind: explicit ? "explicit_instruction" : "approved_decision", authority_id: source.request_id },
  };
}
