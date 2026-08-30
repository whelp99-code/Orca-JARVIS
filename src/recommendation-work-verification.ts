import { createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { closedRecord, closedText, task25Timestamp } from "./task25-closed-input.js";
import type { RecommendationVerificationReceipt } from "./recommendation-work-types.js";

export const RECOMMENDATION_VERIFICATION_DOMAIN = "orca-jarvis/recommendation-verification/v1\0";
const KEYS = ["schema_version", "receipt_id", "verification_request_id", "runtime_id", "run_id",
  "workflow_digest", "dispatch_receipt_id", "commit_digest", "incarnation_id", "artifact_digest",
  "test_digest", "evidence_digest", "decision", "verifier_principal_id", "verifier_session_id",
  "verifier_incarnation_id", "key_id", "algorithm", "issued_at", "signature"] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function invalid(): never { throw new JarvisError("RECOMMENDATION_VERIFICATION_INVALID"); }
function digest(value: unknown): string {
  const parsed = closedText(value, 71); return DIGEST.test(parsed) ? parsed : invalid();
}
export function verificationPayload(receipt: RecommendationVerificationReceipt):
Omit<RecommendationVerificationReceipt, "signature"> {
  const { signature, ...payload } = receipt; void signature; return payload;
}
export function parseRecommendationVerification(value: unknown): RecommendationVerificationReceipt {
  const row = closedRecord(value, KEYS);
  if (row["schema_version"] !== 1 || (row["decision"] !== "PASS" && row["decision"] !== "REJECT")
    || row["algorithm"] !== "Ed25519") return invalid();
  const signature = closedText(row["signature"], 128);
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) return invalid();
  return { schema_version: 1, receipt_id: closedText(row["receipt_id"]),
    verification_request_id: closedText(row["verification_request_id"]),
    runtime_id: closedText(row["runtime_id"]), run_id: closedText(row["run_id"]),
    workflow_digest: digest(row["workflow_digest"]), dispatch_receipt_id: closedText(row["dispatch_receipt_id"]),
    commit_digest: digest(row["commit_digest"]), incarnation_id: closedText(row["incarnation_id"]),
    artifact_digest: digest(row["artifact_digest"]), test_digest: digest(row["test_digest"]),
    evidence_digest: digest(row["evidence_digest"]), decision: row["decision"],
    verifier_principal_id: closedText(row["verifier_principal_id"]),
    verifier_session_id: closedText(row["verifier_session_id"]),
    verifier_incarnation_id: closedText(row["verifier_incarnation_id"]), key_id: closedText(row["key_id"]),
    algorithm: "Ed25519", issued_at: task25Timestamp(row["issued_at"]), signature };
}
export function verifyRecommendationReceipt(
  value: unknown, publicKey: string, now: Date,
): RecommendationVerificationReceipt {
  const receipt = parseRecommendationVerification(value); const issued = Date.parse(receipt.issued_at);
  if (issued > now.getTime() || now.getTime() - issued > 15 * 60_000) return invalid();
  try {
    const key = createPublicKey(publicKey); const signature = Buffer.from(receipt.signature, "base64url");
    if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64
      || !verify(null, Buffer.from(RECOMMENDATION_VERIFICATION_DOMAIN
        + canonicalize(verificationPayload(receipt))), key, signature)) return invalid();
    return receipt;
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    return invalid();
  }
}
