import type { SecondBrainWriteOperation, SecondBrainWriteOutcome, SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";

const OPERATIONS = ["remember", "correct", "forget", "export"] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const PURPOSES = ["personal_memory", "data_erasure", "data_portability"] as const;
const ROOT_KEYS = ["candidate_digest", "candidate_id", "classification_digest", "created_at", "expected_prior", "expires_at", "idempotency_key", "operation", "payload", "purpose", "receipt", "receipt_digest", "request_digest", "request_id", "retention_days", "schema_version", "sensitivity", "subject"] as const;
const RECEIPT_KEYS = ["candidate_digest", "candidate_id", "classification_digest", "decision", "expires_at", "issued_at", "operation", "principal_id", "receipt_id", "schema_version"] as const;
const PRIOR_KEYS = ["source_digest", "source_id", "source_version"] as const;
const RESULT_KEYS = ["accepted_at", "candidate_id", "idempotency_key", "inbox_path", "kind", "operation", "replayed", "request_digest", "request_file_digest", "request_id", "schema_version", "state"] as const;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? Object.fromEntries(Object.entries(value)) : undefined;
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value === value.normalize("NFC")
    && ![...value].some(character => { const code = character.codePointAt(0) ?? 0; return code < 32 || code === 127; }) ? value : undefined;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | undefined {
  const parsed = text(value); return parsed === undefined ? undefined : values.find(item => item === parsed);
}
function stringRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, string>> | undefined {
  const parsed = record(value); if (parsed === undefined || !exact(parsed, keys)) return undefined;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, item] of Object.entries(parsed)) { const valueText = text(item); if (valueText === undefined) return undefined; entries.push([key, valueText]); }
  return Object.freeze(Object.fromEntries(entries));
}
function parseReceipt(value: unknown, operation: SecondBrainWriteOperation): Readonly<Record<string, string | number>> | undefined {
  const parsed = record(value); if (parsed === undefined || !exact(parsed, RECEIPT_KEYS) || parsed["schema_version"] !== 1
    || parsed["operation"] !== operation || parsed["principal_id"] !== "principal:owner"
    || member(parsed["decision"], ["auto_staged", "owner_confirmed"] as const) === undefined) return undefined;
  const result: Record<string, string | number> = { schema_version: 1 };
  for (const key of RECEIPT_KEYS) { if (key === "schema_version") continue; const item = text(parsed[key]); if (item === undefined) return undefined; result[key] = item; }
  return Object.freeze(result);
}
function parsePayload(value: unknown, operation: SecondBrainWriteOperation): Readonly<Record<string, string>> | undefined {
  switch (operation) {
    case "remember": case "correct": return stringRecord(value, ["content"]);
    case "forget": { const parsed = stringRecord(value, ["disposition"]); return parsed?.["disposition"] === "owner_requested" ? parsed : undefined; }
    case "export": { const parsed = stringRecord(value, ["format", "scope"]); return parsed?.["format"] === "json" && parsed["scope"] === "subject" ? parsed : undefined; }
    default: return undefined;
  }
}

export function parseSecondBrainWriteRequest(value: unknown): SecondBrainWriteRequestV1 | undefined {
  const input = record(value); if (input === undefined || !exact(input, ROOT_KEYS) || input["schema_version"] !== 1) return undefined;
  const operation = member(input["operation"], OPERATIONS); const sensitivity = member(input["sensitivity"], SENSITIVITIES);
  const purpose = member(input["purpose"], PURPOSES); if (operation === undefined || sensitivity === undefined || purpose === undefined) return undefined;
  const candidateId = text(input["candidate_id"]); const candidateDigest = text(input["candidate_digest"]); const classificationDigest = text(input["classification_digest"]);
  const idempotencyKey = text(input["idempotency_key"]); const requestId = text(input["request_id"]); const requestDigest = text(input["request_digest"]);
  const subject = text(input["subject"]); const createdAt = text(input["created_at"]); const expiresAt = text(input["expires_at"]); const receiptDigest = text(input["receipt_digest"]);
  const prior = input["expected_prior"] === null ? null : stringRecord(input["expected_prior"], PRIOR_KEYS); const receipt = parseReceipt(input["receipt"], operation); const payload = parsePayload(input["payload"], operation);
  const retentionDays = input["retention_days"];
  if (candidateId === undefined || candidateDigest === undefined || classificationDigest === undefined
    || idempotencyKey === undefined || requestId === undefined || requestDigest === undefined || subject === undefined
    || createdAt === undefined || expiresAt === undefined || receiptDigest === undefined || prior === undefined
    || receipt === undefined || payload === undefined || typeof retentionDays !== "number" || !Number.isSafeInteger(retentionDays)) return undefined;
  return Object.freeze({ schema_version: 1, candidate_id: candidateId, candidate_digest: candidateDigest, classification_digest: classificationDigest,
    idempotency_key: idempotencyKey, request_id: requestId, request_digest: requestDigest, operation, subject, purpose, sensitivity,
    retention_days: retentionDays, created_at: createdAt, expires_at: expiresAt, expected_prior: prior, receipt, receipt_digest: receiptDigest, payload });
}

export function snapshotSecondBrainWriteArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const input = record(value); if (input === undefined || !exact(input, ["request"])) return undefined;
  const request = parseSecondBrainWriteRequest(input["request"]); return request === undefined ? undefined : Object.freeze({ request });
}

export function parseSecondBrainWriteResult(value: unknown): SecondBrainWriteOutcome | undefined {
  const result = record(value); if (result === undefined || !exact(result, RESULT_KEYS) || result["schema_version"] !== 1 || result["kind"] !== "accepted" || result["state"] !== "pending" || typeof result["replayed"] !== "boolean") return undefined;
  const operation = member(result["operation"], OPERATIONS); const candidateId = text(result["candidate_id"]); const requestId = text(result["request_id"]); const requestDigest = text(result["request_digest"]); const idempotencyKey = text(result["idempotency_key"]); const acceptedAt = text(result["accepted_at"]); const inboxPath = text(result["inbox_path"]); const fileDigest = text(result["request_file_digest"]);
  if (operation === undefined || candidateId === undefined || requestId === undefined || requestDigest === undefined || idempotencyKey === undefined || acceptedAt === undefined || inboxPath === undefined || fileDigest === undefined) return undefined;
  return { kind: "accepted", state: "pending", candidate_id: candidateId, request_id: requestId, request_digest: requestDigest, idempotency_key: idempotencyKey, operation, accepted_at: acceptedAt, inbox_path: inboxPath, request_file_digest: fileDigest, replayed: result["replayed"] };
}
