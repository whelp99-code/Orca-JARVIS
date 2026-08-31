import type {
  SecondBrainWriteOperation,
  SecondBrainWriteOutcome,
} from "./second-brain-adapter-types.js";

const OPERATIONS = ["remember", "correct", "forget", "export"] as const;
const RESULT_KEYS = [
  "accepted_at", "candidate_id", "idempotency_key", "inbox_path", "kind", "operation",
  "replayed", "request_digest", "request_file_digest", "request_id", "schema_version", "state",
] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}
function exact(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).sort().join("\0") === [...RESULT_KEYS].sort().join("\0");
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && value === value.normalize("NFC") ? value : undefined;
}
function operation(value: unknown): SecondBrainWriteOperation | undefined {
  return typeof value === "string" ? OPERATIONS.find(item => item === value) : undefined;
}
function instant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return INSTANT.test(value) && Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}
export function parseSecondBrainWriteResult(value: unknown): SecondBrainWriteOutcome | undefined {
  const result = record(value); const replayed = result?.["replayed"];
  if (result === undefined || !exact(result) || result["schema_version"] !== 1
    || result["kind"] !== "accepted" || result["state"] !== "pending"
    || typeof replayed !== "boolean") return undefined;
  const parsedOperation = operation(result["operation"]);
  const candidateId = text(result["candidate_id"]); const requestId = text(result["request_id"]);
  const requestDigest = text(result["request_digest"]);
  const idempotencyKey = text(result["idempotency_key"]); const acceptedAt = text(result["accepted_at"]);
  const inboxPath = text(result["inbox_path"]); const fileDigest = text(result["request_file_digest"]);
  if (parsedOperation === undefined || candidateId === undefined || requestId === undefined
    || requestDigest === undefined || idempotencyKey === undefined || acceptedAt === undefined
    || inboxPath === undefined || fileDigest === undefined) return undefined;
  if (!/^memcand:pos:v1:[0-9a-f]{64}$/.test(candidateId)
    || !/^memreq:pos:v1:[0-9a-f]{64}$/.test(requestId)
    || !/^memidem:pos:v1:[0-9a-f]{64}$/.test(idempotencyKey) || !DIGEST.test(requestDigest)
    || !DIGEST.test(fileDigest) || !instant(acceptedAt)
    || inboxPath !== `inbox/.requests/pending/${requestId}.json`) return undefined;
  return { kind: "accepted", state: "pending", candidate_id: candidateId, request_id: requestId,
    request_digest: requestDigest, idempotency_key: idempotencyKey, operation: parsedOperation,
    accepted_at: acceptedAt, inbox_path: inboxPath, request_file_digest: fileDigest, replayed };
}
