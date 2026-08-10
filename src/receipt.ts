import { sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { DecisionReceipt, PolicyAuthorization, VerificationEvidence } from "./types.js";

export const RECEIPT_DOMAIN = "orca-jarvis/decision-receipt/v1\u0000";
export const POLICY_DOMAIN = "orca-jarvis/policy-authorization/v1\u0000";
export const VERIFICATION_DOMAIN = "orca-jarvis/verification-evidence/v1\u0000";
export function base64url(buffer: Buffer): string { return buffer.toString("base64url"); }
export function unbase64url(value: string): Buffer { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url"); return Buffer.from(value, "base64url"); }
export function receiptPayload(receipt: DecisionReceipt): Omit<DecisionReceipt, "signature"> { const { signature, ...payload } = receipt; void signature; return payload; }
export function policyPayload(policy: PolicyAuthorization): Omit<PolicyAuthorization, "signature"> { const { signature, ...payload } = policy; void signature; return payload; }
export function verificationPayload(evidence: VerificationEvidence): Omit<VerificationEvidence, "signature"> { const { signature, ...payload } = evidence; void signature; return payload; }
export function signReceipt(payload: Omit<DecisionReceipt, "signature">, key: KeyObject): DecisionReceipt { return { ...payload, signature: base64url(sign(null, Buffer.from(RECEIPT_DOMAIN + canonicalize(payload)), key)) }; }
export function signPolicy(payload: Omit<PolicyAuthorization, "signature">, key: KeyObject): PolicyAuthorization { return { ...payload, signature: base64url(sign(null, Buffer.from(POLICY_DOMAIN + canonicalize(payload)), key)) }; }
export function signVerificationEvidence(payload: Omit<VerificationEvidence, "signature">, key: KeyObject): VerificationEvidence { return { ...payload, signature: base64url(sign(null, Buffer.from(VERIFICATION_DOMAIN + canonicalize(payload)), key)) }; }
export function verifyDecisionReceipt(receipt: DecisionReceipt, trustedPublicKey: string, timestamp: Date): boolean {
  const issued = Date.parse(receipt.issued_at); const notBefore = Date.parse(receipt.not_before); const expires = Date.parse(receipt.expires_at);
  if (receipt.schema_version !== 1 || (receipt.decision !== "approve" && receipt.decision !== "reject") || receipt.algorithm !== "Ed25519" || receipt.max_uses !== 1 || receipt.status !== "issued" || !receipt.nonce || !Number.isFinite(issued) || !Number.isFinite(notBefore) || !Number.isFinite(expires) || issued > timestamp.getTime() || notBefore > timestamp.getTime() || expires <= issued || expires <= timestamp.getTime() || expires - issued > 15 * 60_000) return false;
  try { return verify(null, Buffer.from(RECEIPT_DOMAIN + canonicalize(receiptPayload(receipt))), trustedPublicKey, unbase64url(receipt.signature)); } catch { return false; }
}
export function verifyPolicyAuthorization(policy: PolicyAuthorization, trustedPublicKey: string, timestamp: Date): boolean {
  const issued = Date.parse(policy.issued_at); const notBefore = Date.parse(policy.not_before); const expires = Date.parse(policy.expires_at);
  if (policy.schema_version !== 1 || policy.algorithm !== "Ed25519" || policy.max_uses !== 1 || policy.status !== "issued" || !policy.nonce || !Number.isFinite(issued) || !Number.isFinite(notBefore) || !Number.isFinite(expires) || issued > timestamp.getTime() || notBefore > timestamp.getTime() || expires <= issued || expires <= timestamp.getTime() || expires - issued > 15 * 60_000) return false;
  try { return verify(null, Buffer.from(POLICY_DOMAIN + canonicalize(policyPayload(policy))), trustedPublicKey, unbase64url(policy.signature)); } catch { return false; }
}
export function verifyVerificationEvidence(evidence: VerificationEvidence, trustedPublicKey: string): boolean { if (evidence.schema_version !== 1 || evidence.expected_exit !== 0 || evidence.actual_exit !== 0) return false; try { return verify(null, Buffer.from(VERIFICATION_DOMAIN + canonicalize(verificationPayload(evidence))), trustedPublicKey, unbase64url(evidence.signature)); } catch { return false; } }
