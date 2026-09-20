import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JarvisError } from "../jarvis-error.js";
import {
  CORE5_INTEGRATION_CAPABILITIES,
  EXECUTION_STATUSES,
  type ApprovalRef,
  type CommandEnvelope,
  type EvidenceRef,
  type ExecutionResult,
  type VerifiedCallerContext,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/integration/v1");

export function integrationContractDir(): string {
  return CONTRACT_DIR;
}

export function loadIntegrationSchema(name: string): Readonly<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, name), "utf8")) as Record<string, unknown>;
}

export function loadIntegrationFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACT_DIR, "fixtures", name), "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new JarvisError("CORE5_SCHEMA_INVALID", key);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record)) return undefined;
  return requireString(record, key);
}

function keysOf(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new JarvisError("CORE5_SCHEMA_INVALID", key);
  }
}

export function parseEvidenceRef(value: unknown): EvidenceRef {
  if (!isRecord(value)) throw new JarvisError("CORE5_SCHEMA_INVALID", "EvidenceRef");
  keysOf(value, ["kind", "digest", "uri"]);
  const kind = requireString(value, "kind");
  const digest = requireString(value, "digest");
  if (!DIGEST.test(digest)) throw new JarvisError("CORE5_SCHEMA_INVALID", "digest");
  const uri = optionalString(value, "uri");
  return uri === undefined ? { kind, digest } : { kind, digest, uri };
}

export function parseApprovalRef(value: unknown): ApprovalRef {
  if (!isRecord(value)) throw new JarvisError("CORE5_SCHEMA_INVALID", "ApprovalRef");
  keysOf(value, ["approval_id", "digest", "issued_at"]);
  const approval_id = requireString(value, "approval_id");
  const digest = requireString(value, "digest");
  if (!DIGEST.test(digest)) throw new JarvisError("CORE5_SCHEMA_INVALID", "digest");
  const issued_at = optionalString(value, "issued_at");
  return issued_at === undefined ? { approval_id, digest } : { approval_id, digest, issued_at };
}

export function parseVerifiedCaller(value: unknown): VerifiedCallerContext {
  if (!isRecord(value)) throw new JarvisError("CORE5_SCHEMA_INVALID", "caller");
  keysOf(value, ["principal", "workspace", "purpose", "expiry", "audience"]);
  return {
    principal: requireString(value, "principal"),
    workspace: requireString(value, "workspace"),
    purpose: requireString(value, "purpose"),
    expiry: requireString(value, "expiry"),
    audience: requireString(value, "audience"),
  };
}

export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  if (!isRecord(value)) throw new JarvisError("CORE5_SCHEMA_INVALID", "CommandEnvelope");
  keysOf(value, [
    "schema_version", "operation_id", "attempt_id", "lease_fence", "capability",
    "payload", "caller", "evidence_refs", "approval_ref",
  ]);
  if (value["schema_version"] !== 1) throw new JarvisError("CORE5_SCHEMA_INVALID", "schema_version");
  const operation_id = requireString(value, "operation_id");
  const attempt_id = requireString(value, "attempt_id");
  const lease_fence = requireString(value, "lease_fence");
  if (operation_id === attempt_id || operation_id === lease_fence || attempt_id === lease_fence) {
    throw new JarvisError("CORE5_IDS_NOT_DISTINCT", "operation_id/attempt_id/lease_fence");
  }
  const capability = requireString(value, "capability");
  if (!(CORE5_INTEGRATION_CAPABILITIES as readonly string[]).includes(capability)) {
    throw new JarvisError("CORE5_CAPABILITY_UNKNOWN", capability);
  }
  const payload = value["payload"];
  if (!isRecord(payload)) throw new JarvisError("CORE5_SCHEMA_INVALID", "payload");
  const evidence_refs = value["evidence_refs"] === undefined
    ? undefined
    : (Array.isArray(value["evidence_refs"]) ? value["evidence_refs"].map(parseEvidenceRef) : (() => {
      throw new JarvisError("CORE5_SCHEMA_INVALID", "evidence_refs");
    })());
  const approval_ref = value["approval_ref"] === undefined ? undefined : parseApprovalRef(value["approval_ref"]);
  return {
    schema_version: 1,
    operation_id,
    attempt_id,
    lease_fence,
    capability: capability as CommandEnvelope["capability"],
    payload,
    caller: parseVerifiedCaller(value["caller"]),
    ...(evidence_refs === undefined ? {} : { evidence_refs }),
    ...(approval_ref === undefined ? {} : { approval_ref }),
  };
}

export function parseExecutionResult(value: unknown): ExecutionResult {
  if (!isRecord(value)) throw new JarvisError("CORE5_SCHEMA_INVALID", "ExecutionResult");
  keysOf(value, [
    "schema_version", "operation_id", "attempt_id", "lease_fence", "status", "evidence_refs", "error_code",
  ]);
  if (value["schema_version"] !== 1) throw new JarvisError("CORE5_SCHEMA_INVALID", "schema_version");
  const status = requireString(value, "status");
  if (!(EXECUTION_STATUSES as readonly string[]).includes(status)) {
    throw new JarvisError("CORE5_SCHEMA_INVALID", "status");
  }
  const evidence_refs = value["evidence_refs"] === undefined
    ? undefined
    : (Array.isArray(value["evidence_refs"]) ? value["evidence_refs"].map(parseEvidenceRef) : (() => {
      throw new JarvisError("CORE5_SCHEMA_INVALID", "evidence_refs");
    })());
  const error_code = optionalString(value, "error_code");
  return {
    schema_version: 1,
    operation_id: requireString(value, "operation_id"),
    attempt_id: requireString(value, "attempt_id"),
    lease_fence: requireString(value, "lease_fence"),
    status: status as ExecutionResult["status"],
    ...(evidence_refs === undefined ? {} : { evidence_refs }),
    ...(error_code === undefined ? {} : { error_code }),
  };
}

export function isTerminalSuccessOrFail(status: ExecutionResult["status"]): boolean {
  return status === "SUCCESS" || status === "FAIL";
}
