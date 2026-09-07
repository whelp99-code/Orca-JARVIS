import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";
import {
  openPrivateSpoolRoot,
  readPrivateSpoolFile,
  removePrivateSpoolFile,
  type PrivateSpoolRoot,
  writePrivateSpoolFile,
} from "./memory-private-spool-files.js";
import {
  type MemoryCandidateReviewEnvelope,
  memoryCandidateReviewDigest,
} from "./memory-candidate-review-spool.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import { providerWriteReceipt, providerWriteIdempotencyKey, receiptDigest, writeRequestDigest, writeRequestId,
  type CorrectTarget, type DispatchReceipt } from "./memory-candidate-dispatch-receipts.js";

const DISPATCH_DOMAIN = "orca-jarvis/memory-candidate-dispatch/v1\0";
const CANDIDATE_ID = /^memcand:pos:v1:[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type MemoryCandidateDispatchEnvelope =
  | {
    readonly schema_version: 1 | 3;
    readonly body_profile?: "plain-text-v1";
    readonly operation: "remember";
    readonly candidate_id: string;
    readonly candidate_digest: string;
    readonly classification_digest: string;
    readonly content_digest: string;
    readonly review_spool_digest: string;
    readonly decision: "auto_staged" | "owner_confirmed";
    readonly control_request_id: string;
    readonly control_receipt_id: string;
    readonly command_digest: string;
    readonly idempotency_key: string;
    readonly request_id: string;
    readonly request_digest: string;
    readonly retention_days: number;
    readonly created_at: string;
    readonly purpose: "personal_memory";
    readonly sensitivity: "public" | "personal" | "sensitive" | "restricted";
    readonly issued_at: string;
    readonly principal_id: "principal:owner";
    readonly receipt_digest: string;
    readonly expires_at: string;
    readonly dispatch_spool_digest: string;
  }
  | {
    readonly schema_version: 2;
    readonly operation: "correct";
    readonly candidate_id: string;
    readonly candidate_digest: string;
    readonly classification_digest: string;
    readonly content_digest: string;
    readonly review_spool_digest: string;
    readonly decision: "auto_staged" | "owner_confirmed";
    readonly control_request_id: string;
    readonly control_receipt_id: string;
    readonly command_digest: string;
    readonly idempotency_key: string;
    readonly request_id: string;
    readonly request_digest: string;
    readonly retention_days: number;
    readonly created_at: string;
    readonly purpose: "personal_memory";
    readonly sensitivity: "public" | "personal" | "sensitive" | "restricted";
    readonly issued_at: string;
    readonly principal_id: "principal:owner";
    readonly receipt_digest: string;
    readonly target_version_digest: string;
    readonly expected_prior_digest: string;
    readonly target_manifest_digest: string;
    readonly scope_digest: string;
    readonly expected_prior: Readonly<Record<string, string>>;
    readonly expires_at: string;
    readonly dispatch_spool_digest: string;
  };

export type MemoryCandidateDispatchPublication = {
  readonly candidate_id: string;
  readonly path: string;
  readonly dispatch_spool_digest: string;
  readonly operation: "remember" | "correct";
  readonly schema_version: 1 | 2 | 3;
  readonly created: boolean;
};


export class MemoryCandidateDispatchSpool {
  private readonly spool: PrivateSpoolRoot;

  constructor(root: string) {
    this.spool = openPrivateSpoolRoot(root);
  }

  publish(
    review: MemoryCandidateReviewEnvelope,
    receipt: DispatchReceipt,
    target?: CorrectTarget,
  ): MemoryCandidateDispatchPublication {
    if (memoryCandidateReviewDigest(review) !== review.review_envelope_digest) {
      throw new Error("MEMORY_DISPATCH_REVIEW_INTEGRITY_FAILURE");
    }
    if ((review.operation === "remember") !== (target === undefined)) {
      throw new Error("MEMORY_DISPATCH_OPERATION_MISMATCH");
    }
    const common = {
      candidate_id: review.candidate_id,
      candidate_digest: review.candidate_digest,
      classification_digest: review.classification_digest,
      content_digest: review.content_digest,
      review_spool_digest: review.review_envelope_digest,
      decision: receipt.decision ?? "owner_confirmed",
      idempotency_key: providerWriteIdempotencyKey(review),
      request_id: writeRequestId(review, receipt, target),
      request_digest: writeRequestDigest(review, receipt, target),
      retention_days: review.retention_days,
      created_at: review.created_at,
      purpose: "personal_memory" as const,
      sensitivity: review.sensitivity,
      receipt_digest: receiptDigest(review, receipt, target === undefined ? "remember" : "correct"),
      ...receipt,
    };
    const core = target === undefined
      ? {
        schema_version: review.schema_version === 2 ? 3 as const : 1 as const,
        ...(review.schema_version === 2 ? { body_profile: "plain-text-v1" as const } : {}),
        operation: "remember" as const,
        ...common,
      }
      : {
        schema_version: 2 as const,
        operation: "correct" as const,
        ...common,
        ...target,
      };
    const envelope: MemoryCandidateDispatchEnvelope = {
      ...core,
      dispatch_spool_digest: dispatchDigest(core),
    };
    const path = this.filePath(envelope.candidate_id);
    const created = writePrivateSpoolFile(this.spool, path, Buffer.from(canonicalize(envelope), "utf8"), "dispatch");
    const existing = readDispatchFile(this.spool, path);
    if (existing.dispatch_spool_digest !== envelope.dispatch_spool_digest) {
      throw new Error("MEMORY_DISPATCH_REPLAY_CONFLICT");
    }
    return {
      candidate_id: envelope.candidate_id,
      path,
      dispatch_spool_digest: envelope.dispatch_spool_digest,
      operation: envelope.operation,
      schema_version: envelope.schema_version,
      created,
    };
  }

  read(candidateId: string): MemoryCandidateDispatchEnvelope {
    return readDispatchFile(this.spool, this.filePath(candidateId));
  }

  pathFor(candidateId: string): string { return this.filePath(candidateId); }

  remove(publication: MemoryCandidateDispatchPublication): void {
    const current = readDispatchFile(this.spool, publication.path);
    if (current.candidate_id !== publication.candidate_id
      || current.dispatch_spool_digest !== publication.dispatch_spool_digest) {
      throw new Error("MEMORY_DISPATCH_REPLAY_CONFLICT");
    }
    removePrivateSpoolFile(this.spool, publication.path);
  }

  private filePath(candidateId: string): string {
    if (!CANDIDATE_ID.test(candidateId)) throw new Error("MEMORY_DISPATCH_CANDIDATE_INVALID");
    return join(this.spool.path, `${candidateId.replaceAll(":", "_")}.json`);
  }
}

export function memoryCandidateDispatchDigest(
  envelope: MemoryCandidateDispatchEnvelope,
): string {
  const core = Object.fromEntries(Object.entries(envelope)
    .filter(([key]) => key !== "dispatch_spool_digest")) as Omit<MemoryCandidateDispatchEnvelope, "dispatch_spool_digest">;
  return dispatchDigest(core);
}

function dispatchDigest(value: Omit<MemoryCandidateDispatchEnvelope, "dispatch_spool_digest">): string {
  return `sha256:${createHash("sha256").update(DISPATCH_DOMAIN).update(canonicalize(value)).digest("hex")}`;
}

function readDispatchFile(root: PrivateSpoolRoot, path: string): MemoryCandidateDispatchEnvelope {
  const parsed = parseSecondBrainStrictJsonBytes(readPrivateSpoolFile(root, path));
  if (!isDispatchRecord(parsed) || memoryCandidateDispatchDigest(parsed) !== parsed.dispatch_spool_digest) {
    throw new Error("MEMORY_DISPATCH_INTEGRITY_FAILURE");
  }
  return parsed;
}

function isDispatchRecord(value: unknown): value is MemoryCandidateDispatchEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const base = [
    "candidate_id", "candidate_digest", "classification_digest", "content_digest",
    "review_spool_digest", "decision", "control_request_id", "control_receipt_id", "command_digest",
    "idempotency_key", "request_id", "request_digest", "retention_days", "created_at",
    "purpose", "sensitivity", "issued_at", "principal_id", "receipt_digest", "expires_at",
    "dispatch_spool_digest",
  ];
  const correct = [
    ...base, "target_version_digest", "expected_prior_digest", "target_manifest_digest", "scope_digest",
    "expected_prior",
  ];
  if (record.schema_version === 3) base.push("body_profile");
  const expected = record.operation === "remember" ? base : record.operation === "correct" ? correct : [];
  if (expected.length === 0 || Object.keys(record).length !== expected.length + 2
    || expected.some(key => !(key in record))) return false;
  const schema = record.operation === "remember" ? (record.schema_version === 3 ? 3 : 1) : 2;
  return record.schema_version === schema
    && (schema !== 3 || record.body_profile === "plain-text-v1")
    && typeof record.candidate_id === "string" && CANDIDATE_ID.test(record.candidate_id)
    && typeof record.candidate_digest === "string" && DIGEST.test(record.candidate_digest)
    && typeof record.classification_digest === "string" && DIGEST.test(record.classification_digest)
    && typeof record.content_digest === "string" && DIGEST.test(record.content_digest)
    && typeof record.review_spool_digest === "string" && DIGEST.test(record.review_spool_digest)
    && (record.decision === "auto_staged" || record.decision === "owner_confirmed")
    && typeof record.control_request_id === "string" && record.control_request_id.length > 0
    && typeof record.control_receipt_id === "string" && record.control_receipt_id.length > 0
    && typeof record.command_digest === "string" && DIGEST.test(record.command_digest)
    && typeof record.idempotency_key === "string" && /^memidem:pos:v1:[0-9a-f]{64}$/u.test(record.idempotency_key)
    && typeof record.request_id === "string" && new RegExp(`^memreq:pos:v${schema === 3 ? 3 : 1}:[0-9a-f]{64}$`, "u").test(record.request_id)
    && typeof record.request_digest === "string" && DIGEST.test(record.request_digest)
    && typeof record.retention_days === "number" && Number.isSafeInteger(record.retention_days)
    && typeof record.created_at === "string" && record.purpose === "personal_memory"
    && (record.sensitivity === "public" || record.sensitivity === "personal"
      || record.sensitivity === "sensitive" || record.sensitivity === "restricted")
    && typeof record.issued_at === "string" && record.principal_id === "principal:owner"
    && typeof record.receipt_digest === "string" && DIGEST.test(record.receipt_digest)
    && typeof record.expires_at === "string" && typeof record.dispatch_spool_digest === "string"
    && DIGEST.test(record.dispatch_spool_digest)
    && (record.operation !== "correct" || (
      typeof record.target_version_digest === "string" && DIGEST.test(record.target_version_digest)
      && typeof record.expected_prior_digest === "string" && DIGEST.test(record.expected_prior_digest)
      && typeof record.target_manifest_digest === "string" && DIGEST.test(record.target_manifest_digest)
      && typeof record.scope_digest === "string" && DIGEST.test(record.scope_digest)
      && typeof record.expected_prior === "object" && record.expected_prior !== null
      && !Array.isArray(record.expected_prior)
    ));
}

export function memoryCandidateWriteReceipt(
  envelope: MemoryCandidateDispatchEnvelope,
): Readonly<Record<string, string | number>> {
  return providerWriteReceipt({ candidate_id: envelope.candidate_id,
    candidate_digest: envelope.candidate_digest, operation: envelope.operation,
    classification_digest: envelope.classification_digest },
  { control_receipt_id: envelope.control_receipt_id, principal_id: envelope.principal_id,
    issued_at: envelope.issued_at, expires_at: envelope.expires_at, decision: envelope.decision });
}
