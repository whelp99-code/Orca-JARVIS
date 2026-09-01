import { unbase64url } from "./receipt.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "closed_keys");
  }
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "text");
  }
  return value;
}
function b64(value: unknown, maxBytes: number, exact?: number): Buffer {
  const raw = text(value, 8192);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "base64url");
  }
  const bytes = unbase64url(raw);
  if (bytes.byteLength > maxBytes || (exact !== undefined && bytes.byteLength !== exact)) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "bytes");
  }
  return bytes;
}

export type ParsedAssertion = Readonly<{
  id: string;
  rawId: Buffer;
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
  userHandle: Buffer;
  attachment: string | null;
  clientExtensionResults: Readonly<Record<string, never>>;
}>;

export type ParsedAttestation = Readonly<{
  id: string;
  rawId: Buffer;
  clientDataJSON: Buffer;
  attestationObject: Buffer;
  attachment: string | null;
  clientExtensionResults: Readonly<Record<string, never>>;
}>;

export function parseAssertionCredential(value: unknown): ParsedAssertion {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "credential");
  closed(value, ["id", "rawId", "type", "response", "authenticatorAttachment", "clientExtensionResults"]);
  if (value.type !== "public-key") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "type");
  if (!isRecord(value.response)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "response");
  closed(value.response, ["clientDataJSON", "authenticatorData", "signature", "userHandle"]);
  if (!isRecord(value.clientExtensionResults) || Object.keys(value.clientExtensionResults).length !== 0) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "extensions");
  }
  const rawId = b64(value.rawId, 1024);
  const id = text(value.id, 2048);
  if (id !== value.rawId) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "id_mismatch");
  const attachment = value.authenticatorAttachment === null ? null : text(value.authenticatorAttachment, 32);
  return {
    id,
    rawId,
    clientDataJSON: b64(value.response.clientDataJSON, 4096),
    authenticatorData: b64(value.response.authenticatorData, 1024),
    signature: b64(value.response.signature, 1024),
    userHandle: b64(value.response.userHandle, 32, 32),
    attachment,
    clientExtensionResults: {},
  };
}

export function parseAttestationCredential(value: unknown): ParsedAttestation {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "credential");
  closed(value, ["id", "rawId", "type", "response", "authenticatorAttachment", "clientExtensionResults"]);
  if (value.type !== "public-key") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "type");
  if (!isRecord(value.response)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "response");
  closed(value.response, ["clientDataJSON", "attestationObject"]);
  if ("userHandle" in value.response) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "userHandle");
  if (!isRecord(value.clientExtensionResults) || Object.keys(value.clientExtensionResults).length !== 0) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "extensions");
  }
  const rawId = b64(value.rawId, 1024);
  const id = text(value.id, 2048);
  if (id !== value.rawId) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "id_mismatch");
  const attachment = value.authenticatorAttachment === null ? null : text(value.authenticatorAttachment, 32);
  return {
    id,
    rawId,
    clientDataJSON: b64(value.response.clientDataJSON, 4096),
    attestationObject: b64(value.response.attestationObject, 8192),
    attachment,
    clientExtensionResults: {},
  };
}

export function parseDecisionBody(value: unknown): "approve" | "reject" {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "body");
  closed(value, ["schema_version", "decision"]);
  if (value.schema_version !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "schema");
  if (value.decision !== "approve" && value.decision !== "reject") {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "decision");
  }
  return value.decision;
}

export function parseSchemaBody(value: unknown): void {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "body");
  closed(value, ["schema_version"]);
  if (value.schema_version !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "schema");
}

export function parseVerifyBody(value: unknown): unknown {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "body");
  closed(value, ["schema_version", "credential"]);
  if (value.schema_version !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "schema");
  return value.credential;
}

export function parseBeginRequestBody(value: unknown): string {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "body");
  closed(value, ["schema_version", "begin_request_id"]);
  if (value.schema_version !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "schema");
  return text(value.begin_request_id, 128);
}

export function parseReasonBody(value: unknown): string {
  if (!isRecord(value)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "body");
  closed(value, ["schema_version", "reason"]);
  if (value.schema_version !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "schema");
  if (typeof value.reason !== "string" || value.reason !== value.reason.normalize("NFC")) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "reason");
  }
  const bytes = Buffer.byteLength(value.reason, "utf8");
  if (bytes < 1 || bytes > 256) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "reason");
  return value.reason;
}
