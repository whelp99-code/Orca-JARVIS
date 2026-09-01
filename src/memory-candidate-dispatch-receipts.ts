import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { MemoryCandidateReviewEnvelope } from "./memory-candidate-review-spool.js";

/** Provider write-request and write-receipt derivation for candidate dispatch. */

export type DispatchReceipt = {
  readonly decision?: "auto_staged" | "owner_confirmed";
  readonly control_request_id: string;
  readonly control_receipt_id: string;
  readonly command_digest: string;
  readonly issued_at: string;
  readonly principal_id: "principal:owner";
  readonly expires_at: string;
};

export type CorrectTarget = {
  readonly target_version_digest: string;
  readonly expected_prior_digest: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly expected_prior: Readonly<Record<string, string>>;
};

export function providerWriteReceipt(
  review: Pick<MemoryCandidateReviewEnvelope, "candidate_id" | "candidate_digest" | "classification_digest"> & {
    readonly operation: "remember" | "correct";
  },
  receipt: Pick<DispatchReceipt, "control_receipt_id" | "principal_id" | "issued_at" | "expires_at" | "decision">,
): Readonly<Record<string, string | number>> {
  return {
    schema_version: 1, receipt_id: providerReceiptId(review.candidate_id, receipt.control_receipt_id),
    candidate_id: review.candidate_id, candidate_digest: review.candidate_digest,
    classification_digest: review.classification_digest, operation: review.operation,
    decision: receipt.decision ?? "owner_confirmed", principal_id: receipt.principal_id,
    issued_at: receipt.issued_at, expires_at: receipt.expires_at,
  };
}

function writeRequestBase(
  review: MemoryCandidateReviewEnvelope,
  receipt: DispatchReceipt,
  target: CorrectTarget | undefined,
): Readonly<Record<string, unknown>> {
  const providerReceipt = providerWriteReceipt(review, receipt);
  return {
    schema_version: 1, candidate_id: review.candidate_id, candidate_digest: review.candidate_digest,
    classification_digest: review.classification_digest, idempotency_key: review.idempotency_key,
    operation: review.operation, subject: review.subject,
    purpose: "personal_memory", sensitivity: review.sensitivity, retention_days: review.retention_days,
    created_at: review.created_at, expires_at: receipt.expires_at,
    expected_prior: target?.expected_prior ?? null, receipt: providerReceipt,
    receipt_digest: `sha256:${createHash("sha256").update("orca-jarvis/memory-write-receipt/v1\0")
      .update(canonicalize(providerReceipt)).digest("hex")}`,
    payload: { content: review.statement },
  };
}

export function writeRequestDigest(
  review: MemoryCandidateReviewEnvelope,
  receipt: DispatchReceipt,
  target: CorrectTarget | undefined,
): string {
  const base = writeRequestBase(review, receipt, target);
  return `sha256:${createHash("sha256").update("orca-jarvis/memory-write-request/v1\0")
    .update(canonicalize(base)).digest("hex")}`;
}

export function writeRequestId(
  review: MemoryCandidateReviewEnvelope,
  receipt: DispatchReceipt,
  target: CorrectTarget | undefined,
): string {
  return `memreq:pos:v1:${writeRequestDigest(review, receipt, target).slice(7)}`;
}

export function receiptDigest(
  review: MemoryCandidateReviewEnvelope,
  receipt: DispatchReceipt,
  operation: "remember" | "correct",
): string {
  const providerReceipt = providerWriteReceipt({ ...review, operation }, receipt);
  return `sha256:${createHash("sha256").update("orca-jarvis/memory-write-receipt/v1\0")
    .update(canonicalize(providerReceipt)).digest("hex")}`;
}

function providerReceiptId(candidateId: string, controlReceiptId: string): string {
  return `receipt:memory:${createHash("sha256").update(
    `${candidateId}\0${controlReceiptId}`,
  ).digest("hex")}`;
}
