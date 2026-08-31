import { createHash } from "node:crypto";
import type {
  SecondBrainWriteOperation,
  SecondBrainWriteRequestV1,
} from "./second-brain-adapter-types.js";
import { canonicalize } from "./canonical.js";

const OPERATIONS = ["remember", "correct", "forget", "export"] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const PURPOSES = ["personal_memory", "data_erasure", "data_portability"] as const;
const ROOT_KEYS = [
  "candidate_digest", "candidate_id", "classification_digest", "created_at", "expected_prior",
  "expires_at", "idempotency_key", "operation", "payload", "purpose", "receipt",
  "receipt_digest", "request_digest", "request_id", "retention_days", "schema_version",
  "sensitivity", "subject",
] as const;
const RECEIPT_KEYS = [
  "candidate_digest", "candidate_id", "classification_digest", "decision", "expires_at",
  "issued_at", "operation", "principal_id", "receipt_id", "schema_version",
] as const;
const PRIOR_KEYS = ["source_digest", "source_id", "source_version"] as const;
const DIGEST_DOMAINS = {
  idempotency: "orca-jarvis/memory-write-idempotency/v1\0",
  receipt: "orca-jarvis/memory-write-receipt/v1\0",
  request: "orca-jarvis/memory-write-request/v1\0",
} as const;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function text(value: unknown, maximum = 4_096): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return undefined;
  if (value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > maximum) return undefined;
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  }) ? undefined : value;
}
function member<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | undefined {
  const parsed = text(value);
  return parsed === undefined ? undefined : values.find(item => item === parsed);
}
function instant(value: unknown): string | undefined {
  const parsed = text(value, 24);
  if (parsed === undefined || !INSTANT.test(parsed)) return undefined;
  const milliseconds = Date.parse(parsed);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === parsed
    ? parsed : undefined;
}
function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}
function stringRecord(
  value: unknown,
  keys: readonly string[],
  maximum = 4_096,
): Readonly<Record<string, string>> | undefined {
  const parsed = record(value);
  if (parsed === undefined || !exact(parsed, keys)) return undefined;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, item] of Object.entries(parsed)) {
    const valueText = text(item, maximum);
    if (valueText === undefined) return undefined;
    entries.push([key, valueText]);
  }
  return Object.freeze(Object.fromEntries(entries));
}
function parseReceipt(
  value: unknown,
  operation: SecondBrainWriteOperation,
): Readonly<Record<string, string | number>> | undefined {
  const parsed = record(value);
  if (parsed === undefined || !exact(parsed, RECEIPT_KEYS) || parsed["schema_version"] !== 1) {
    return undefined;
  }
  if (parsed["operation"] !== operation || parsed["principal_id"] !== "principal:owner") return undefined;
  if (member(parsed["decision"], ["auto_staged", "owner_confirmed"] as const) === undefined) {
    return undefined;
  }
  const result: Record<string, string | number> = { schema_version: 1 };
  for (const key of RECEIPT_KEYS) {
    if (key === "schema_version") continue;
    const item = text(parsed[key]);
    if (item === undefined) return undefined;
    result[key] = item;
  }
  return Object.freeze(result);
}
function parsePrior(value: unknown): Readonly<Record<string, string>> | undefined {
  const parsed = stringRecord(value, PRIOR_KEYS, 512);
  if (parsed === undefined || !/^git:[0-9a-f]{40}$/.test(parsed["source_version"] ?? "")
    || !DIGEST.test(parsed["source_digest"] ?? "")) return undefined;
  const sourceId = parsed["source_id"] ?? "";
  const parts = sourceId.split("/");
  if (!/^(wiki|daily|conflicts)\//.test(sourceId) || sourceId !== sourceId.toLowerCase()
    || sourceId.includes("\\") || parts.some(part => ["", ".", "..", "_proposed"].includes(part))) {
    return undefined;
  }
  return parsed;
}
function parsePayload(
  value: unknown,
  operation: SecondBrainWriteOperation,
): Readonly<Record<string, string>> | undefined {
  switch (operation) {
    case "remember":
    case "correct":
      return stringRecord(value, ["content"], 4_096);
    case "forget": {
      const parsed = stringRecord(value, ["disposition"]);
      return parsed?.["disposition"] === "owner_requested" ? parsed : undefined;
    }
    case "export": {
      const parsed = stringRecord(value, ["format", "scope"]);
      return parsed?.["format"] === "json" && parsed["scope"] === "subject" ? parsed : undefined;
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
function operationMatches(
  operation: SecondBrainWriteOperation,
  purpose: string,
  retention: number,
  prior: Readonly<Record<string, string>> | null,
): boolean {
  switch (operation) {
    case "remember": return purpose === "personal_memory" && retention >= 1 && retention <= 3_650
      && prior === null;
    case "correct": return purpose === "personal_memory" && retention >= 1 && retention <= 3_650
      && prior !== null;
    case "forget": return purpose === "data_erasure" && retention === 30 && prior !== null;
    case "export": return purpose === "data_portability" && retention === 1 && prior !== null;
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

export function parseSecondBrainWriteRequest(
  value: unknown,
  now = new Date(),
): SecondBrainWriteRequestV1 | undefined {
  const input = record(value);
  if (input === undefined || !exact(input, ROOT_KEYS) || input["schema_version"] !== 1) return undefined;
  if (Buffer.byteLength(canonicalize(input), "utf8") > 16_384) return undefined;
  const operation = member(input["operation"], OPERATIONS);
  const sensitivity = member(input["sensitivity"], SENSITIVITIES);
  const purpose = member(input["purpose"], PURPOSES);
  const retention = input["retention_days"];
  if (operation === undefined || sensitivity === undefined || purpose === undefined) return undefined;
  if (typeof retention !== "number" || !Number.isSafeInteger(retention)) return undefined;
  const prior = input["expected_prior"] === null
    ? null : parsePrior(input["expected_prior"]);
  if (prior === undefined || !operationMatches(operation, purpose, retention, prior)) return undefined;
  const receipt = parseReceipt(input["receipt"], operation);
  const payload = parsePayload(input["payload"], operation);
  const candidateId = text(input["candidate_id"], 79);
  const candidateDigest = text(input["candidate_digest"], 71);
  const classificationDigest = text(input["classification_digest"], 71);
  const idempotencyKey = text(input["idempotency_key"], 80);
  const requestId = text(input["request_id"], 79);
  const requestDigest = text(input["request_digest"], 71);
  const subject = text(input["subject"], 512);
  const createdAt = instant(input["created_at"]);
  const expiresAt = instant(input["expires_at"]);
  const receiptDigest = text(input["receipt_digest"], 71);
  if (receipt === undefined || payload === undefined || candidateId === undefined
    || candidateDigest === undefined || classificationDigest === undefined || idempotencyKey === undefined
    || requestId === undefined || requestDigest === undefined || subject === undefined || createdAt === undefined
    || expiresAt === undefined || receiptDigest === undefined) return undefined;
  if (!/^memcand:pos:v1:[0-9a-f]{64}$/.test(candidateId) || !DIGEST.test(candidateDigest)
    || !DIGEST.test(classificationDigest) || !/^memidem:pos:v1:[0-9a-f]{64}$/.test(idempotencyKey)
    || !/^memreq:pos:v1:[0-9a-f]{64}$/.test(requestId) || !DIGEST.test(requestDigest)
    || !DIGEST.test(receiptDigest)
    || !/^receipt:memory:[0-9a-f]{64}$/.test(String(receipt["receipt_id"]))) return undefined;
  const receiptIssued = instant(receipt["issued_at"]);
  const receiptExpires = instant(receipt["expires_at"]);
  if (receiptIssued === undefined || receiptExpires === undefined) return undefined;
  const createdMs = Date.parse(createdAt); const expiresMs = Date.parse(expiresAt); const nowMs = now.getTime();
  if (!(createdMs <= Date.parse(receiptIssued) && Date.parse(receiptIssued) < Date.parse(receiptExpires)
    && createdMs <= nowMs && nowMs < Math.min(expiresMs, Date.parse(receiptExpires))
    && expiresMs > createdMs && expiresMs - createdMs <= 86_400_000)) return undefined;
  if (receipt["candidate_id"] !== candidateId || receipt["candidate_digest"] !== candidateDigest
    || receipt["classification_digest"] !== classificationDigest) return undefined;
  if (receiptDigest !== digest(DIGEST_DOMAINS.receipt, receipt)) return undefined;
  const identity = { candidate_id: candidateId, candidate_digest: candidateDigest,
    classification_digest: classificationDigest, operation };
  const expectedIdempotency = digest(DIGEST_DOMAINS.idempotency, identity);
  if (idempotencyKey !== `memidem:pos:v1:${expectedIdempotency.slice(7)}`) return undefined;
  const base = Object.fromEntries(Object.entries(input).filter(
    ([key]) => key !== "request_id" && key !== "request_digest",
  ));
  const expectedRequest = digest(DIGEST_DOMAINS.request, base);
  if (requestDigest !== expectedRequest || requestId !== `memreq:pos:v1:${expectedRequest.slice(7)}`) {
    return undefined;
  }
  return Object.freeze({ schema_version: 1, candidate_id: candidateId, candidate_digest: candidateDigest,
    classification_digest: classificationDigest, idempotency_key: idempotencyKey, request_id: requestId,
    request_digest: requestDigest, operation, subject, purpose, sensitivity, retention_days: retention,
    created_at: createdAt, expires_at: expiresAt, expected_prior: prior, receipt,
    receipt_digest: receiptDigest, payload });
}

export function snapshotSecondBrainWriteArguments(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const input = record(value);
  if (input === undefined || !exact(input, ["request"])) return undefined;
  const request = parseSecondBrainWriteRequest(input["request"]);
  return request === undefined ? undefined : Object.freeze({ request });
}
