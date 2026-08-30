import { verify } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { MemoryAuthorityResolverInput, ResolvedMemoryAuthority } from "./memory-candidate-authority-types.js";
import { MEMORY_CANDIDATE_DIGEST_DOMAINS, type MemoryCandidateSourceMetadata } from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";
import { unbase64url } from "./receipt.js";

export const MEMORY_VERIFICATION_AUTHORITY_DOMAIN = MEMORY_CANDIDATE_DIGEST_DOMAINS.verificationAuthority;
export type MemoryVerificationAuthorityPayload = {
  readonly schema_version: 1;
  readonly evidence_id: string;
  readonly candidate_id: string;
  readonly correlation_id: string;
  readonly principal_id: string;
  readonly source_id: string;
  readonly source_version: string;
  readonly subject_digest: string;
  readonly content_digest: string;
  readonly operation: "remember" | "correct";
  readonly purpose: "personal_memory";
  readonly sensitivity: "public" | "personal" | "sensitive" | "restricted";
  readonly outcome_id: string;
  readonly outcome: "succeeded";
  readonly attempt_id: string;
  readonly worker_id: string;
  readonly worker_session_id: string;
  readonly verifier_id: string;
  readonly verifier_key_id: string;
  readonly artifact_id: string;
  readonly evidence_digest: string;
  readonly issued_at: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly nonce: string;
  readonly max_uses: 1;
  readonly status: "issued";
};

const PAYLOAD_KEYS = [
  "schema_version", "evidence_id", "candidate_id", "correlation_id", "principal_id", "source_id", "source_version",
  "subject_digest", "content_digest", "operation", "purpose", "sensitivity", "outcome_id", "outcome", "attempt_id",
  "worker_id", "worker_session_id", "verifier_id", "verifier_key_id", "artifact_id", "evidence_digest", "issued_at",
  "not_before", "expires_at", "nonce", "max_uses", "status",
] as const;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
type Row = Record<string, unknown>;

function parsed(value: unknown): Row | null {
  if (typeof value !== "string") return null;
  try {
    const result: unknown = JSON.parse(value);
    if (typeof result !== "object" || result === null || Array.isArray(result) || canonicalize(result) !== value) return null;
    return result as Row;
  } catch { return null; }
}

function exact(value: Row): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === PAYLOAD_KEYS.length && [...PAYLOAD_KEYS].sort().every((key, index) => actual[index] === key);
}

function time(value: unknown): number {
  if (typeof value !== "string" || !ISO.test(value)) return Number.NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : Number.NaN;
}

function validPayload(value: Row): value is MemoryVerificationAuthorityPayload {
  const ids = ["evidence_id", "source_id", "source_version", "outcome_id", "attempt_id", "worker_id", "worker_session_id",
    "verifier_id", "verifier_key_id", "artifact_id", "nonce"];
  return exact(value) && value["schema_version"] === 1 && value["max_uses"] === 1 && value["status"] === "issued"
    && value["outcome"] === "succeeded" && value["purpose"] === "personal_memory"
    && (value["operation"] === "remember" || value["operation"] === "correct")
    && ["public", "personal", "sensitive", "restricted"].includes(String(value["sensitivity"]))
    && ids.every(key => typeof value[key] === "string" && OPAQUE.test(String(value[key])))
    && typeof value["principal_id"] === "string" && value["principal_id"].length > 0
    && /^memcand:pos:v1:[0-9a-f]{64}$/.test(String(value["candidate_id"]))
    && /^corr:memory:[0-9a-f]{64}$/.test(String(value["correlation_id"]))
    && DIGEST.test(String(value["subject_digest"])) && DIGEST.test(String(value["content_digest"]))
    && DIGEST.test(String(value["evidence_digest"]))
    && Number.isFinite(time(value["issued_at"])) && Number.isFinite(time(value["not_before"]))
    && Number.isFinite(time(value["expires_at"]));
}

function exactRow(row: Row, payload: MemoryVerificationAuthorityPayload): boolean {
  return PAYLOAD_KEYS.every(key => row[key] === payload[key]) && row["payload_json"] === canonicalize(payload)
    && row["signer_key_id"] === payload.verifier_key_id && row["verifier_principal"] === payload.verifier_id
    && row["key_purpose"] === "verifier" && row["algorithm"] === "Ed25519";
}

function signatureValid(row: Row, payload: MemoryVerificationAuthorityPayload): boolean {
  if (typeof row["signature"] !== "string" || typeof row["public_key_pem"] !== "string") return false;
  try {
    return verify(null, Buffer.from(MEMORY_VERIFICATION_AUTHORITY_DOMAIN + canonicalize(payload)), row["public_key_pem"], unbase64url(row["signature"]));
  } catch { return false; }
}

function revoked(database: Database.Database, row: Row, payload: MemoryVerificationAuthorityPayload): boolean {
  return database.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?,?) LIMIT 1").get(
    payload.evidence_id, payload.verifier_key_id, payload.nonce, payload.evidence_digest, row["signature"], payload.attempt_id,
  ) !== undefined;
}

export function resolveVerifiedMemoryAuthority(
  database: Database.Database,
  context: MemoryAuthorityResolverInput,
): ResolvedMemoryAuthority | null {
  const { input, identity, now } = context;
  const evidenceId = input.source.evidence_id;
  if (input.source.input_class !== "verified_outcome" || evidenceId === null) return null;
  const row = database.prepare(
    `SELECT e.*,k.public_key_pem,k.principal_id AS verifier_principal,k.algorithm,p.purpose AS key_purpose
     FROM memory_candidate_verification_authority e JOIN trusted_authority_keys k ON k.key_id=e.signer_key_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE e.evidence_id=?`,
  ).get(evidenceId) as Row | undefined;
  if (!row) return null;
  const value = parsed(row["payload_json"]);
  if (!value || !validPayload(value)) return null;
  const payload = value;
  const issued = time(payload.issued_at);
  const notBefore = time(payload.not_before);
  const expires = time(payload.expires_at);
  const exactBinding = payload.evidence_id === evidenceId && payload.candidate_id === identity.candidate_id
    && payload.correlation_id === identity.correlation_id && payload.principal_id === input.principal_id
    && payload.source_id === input.source.source_id && payload.source_version === input.source.source_version
    && payload.subject_digest === identity.subject_digest && payload.content_digest === identity.content_digest
    && payload.operation === input.operation && payload.purpose === input.purpose && payload.sensitivity === input.sensitivity;
  if (!exactBinding || !exactRow(row, payload) || !signatureValid(row, payload) || payload.worker_id === payload.verifier_id
    || issued > now.getTime() || notBefore > now.getTime() || expires <= now.getTime() || expires <= issued
    || expires - issued > 24 * 60 * 60_000 || revoked(database, row, payload)) return null;
  const authorityDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, {
    payload,
    signature: row["signature"],
  });
  const metadata: MemoryCandidateSourceMetadata = {
    source_id: payload.source_id, source_version: payload.source_version, principal_id: payload.principal_id,
    authenticated_session_digest: null, worker_id: payload.worker_id,
    worker_session_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.session, payload.worker_session_id),
    verifier_id: payload.verifier_id, instruction_id: null, outcome_id: payload.outcome_id, attempt_id: payload.attempt_id,
    verification_evidence_id: payload.evidence_id, request_id: null, receipt_id: null, command_digest: null,
    authority_key_id: payload.verifier_key_id, authority_expires_at: payload.expires_at, inference_id: null,
    inference_label: null,
  };
  return {
    valid: true,
    source: metadata,
    references: [{
      kind: "verification", identifier: {
        namespace: "verification_authority",
        id: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, { kind: "evidence", id: payload.evidence_id }).slice(7),
        version: 1,
      },
      evidence_digest: authorityDigest, observed_at: payload.issued_at, fresh_until: payload.expires_at, expires_at: payload.expires_at,
    }, {
      kind: "artifact", identifier: {
        namespace: "verification_artifact",
        id: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.authorityRecord, { kind: "artifact", id: payload.artifact_id }).slice(7),
        version: 1,
      },
      evidence_digest: payload.evidence_digest, observed_at: payload.issued_at, fresh_until: payload.expires_at, expires_at: payload.expires_at,
    }],
    claim: { authority_kind: "verified_outcome", authority_id: payload.evidence_id },
  };
}
