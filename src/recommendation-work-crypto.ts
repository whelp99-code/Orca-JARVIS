import { createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { closedRecord, closedText, task25Timestamp } from "./task25-closed-input.js";
import type {
  DispatchIntent, RecommendationCompletion, SignedDispatchReceipt,
} from "./recommendation-work-types.js";

export const DISPATCH_RECEIPT_DOMAIN = "orca-jarvis/recommendation-dispatch/v1\0";
export const COMPLETION_DOMAIN = "orca-jarvis/recommendation-completion/v1\0";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DISPATCH_KEYS = ["schema_version", "receipt_id", "runtime_id", "intent_id", "attempt_id",
  "task_id", "idempotency_key", "provider", "worktree_id", "terminal_id", "session_id",
  "incarnation_id", "pty_id", "accepted_at", "key_id", "algorithm", "signature"] as const;
const COMPLETION_KEYS = ["schema_version", "source", "runtime_id", "dispatch_receipt_id",
  "dispatch_receipt_digest", "provider", "worktree_id", "terminal_id", "session_id",
  "incarnation_id", "pty_id", "cursor", "sequence", "state", "observed_at", "commit_digest",
  "artifact_digest", "test_digest", "evidence_digest", "event_id", "key_id", "algorithm", "signature"] as const;
function fail(code: string): never { throw new JarvisError(code); }
function digest(value: unknown, code: string): string {
  const parsed = closedText(value, 71); return DIGEST.test(parsed) ? parsed : fail(code);
}
function provider(value: unknown, code: string): "codex" | "claude" {
  return value === "codex" || value === "claude" ? value : fail(code);
}
function signature(value: unknown, code: string): string {
  const parsed = closedText(value, 128); return /^[A-Za-z0-9_-]+$/.test(parsed) ? parsed : fail(code);
}
function validSignature(payload: object, signed: string, domain: string, pem: string): boolean {
  try {
    const key = createPublicKey(pem); const bytes = Buffer.from(signed, "base64url");
    return key.asymmetricKeyType === "ed25519" && bytes.length === 64
      && verify(null, Buffer.from(domain + canonicalize(payload)), key, bytes);
  } catch { return false; }
}
export function dispatchReceiptPayload(value: SignedDispatchReceipt): Omit<SignedDispatchReceipt, "signature"> {
  const { signature: omitted, ...payload } = value; void omitted; return payload;
}
export function completionPayload(value: RecommendationCompletion): Omit<RecommendationCompletion, "signature"> {
  const { signature: omitted, ...payload } = value; void omitted; return payload;
}
export type DispatchVerification = {
  readonly intent: DispatchIntent; readonly publicKey: string; readonly now: Date;
};
export function parseDispatchReceipt(value: unknown, context: DispatchVerification): SignedDispatchReceipt {
  const row = closedRecord(value, DISPATCH_KEYS); const code = "RECOMMENDATION_DISPATCH_RECEIPT_INVALID";
  if (row["schema_version"] !== 1 || row["algorithm"] !== "Ed25519") return fail(code);
  const receipt: SignedDispatchReceipt = { schema_version: 1, receipt_id: closedText(row["receipt_id"]),
    runtime_id: closedText(row["runtime_id"]), intent_id: closedText(row["intent_id"]),
    attempt_id: closedText(row["attempt_id"]), task_id: closedText(row["task_id"]),
    idempotency_key: digest(row["idempotency_key"], code), provider: provider(row["provider"], code),
    worktree_id: closedText(row["worktree_id"]), terminal_id: closedText(row["terminal_id"]),
    session_id: closedText(row["session_id"]), incarnation_id: closedText(row["incarnation_id"]),
    pty_id: closedText(row["pty_id"]), accepted_at: task25Timestamp(row["accepted_at"]),
    key_id: closedText(row["key_id"]), algorithm: "Ed25519", signature: signature(row["signature"], code) };
  if (receipt.runtime_id !== context.intent.runtime_id || receipt.intent_id !== context.intent.intent_id
    || receipt.attempt_id !== context.intent.attempt_id || receipt.task_id !== context.intent.task_id
    || receipt.idempotency_key !== context.intent.idempotency_key
    || Date.parse(receipt.accepted_at) > context.now.getTime()
    || context.now.getTime() - Date.parse(receipt.accepted_at) > 15 * 60_000
    || !validSignature(dispatchReceiptPayload(receipt), receipt.signature, DISPATCH_RECEIPT_DOMAIN,
      context.publicKey)) return fail(code);
  return receipt;
}
export type CompletionVerification = { readonly publicKey: string; readonly now: Date };
export function parseCompletion(value: unknown, context: CompletionVerification): RecommendationCompletion {
  const row = closedRecord(value, COMPLETION_KEYS); const code = "RECOMMENDATION_PROGRESS_INVALID";
  if (row["schema_version"] !== 1 || row["source"] !== "recommendation_worker"
    || row["state"] !== "completed" || row["algorithm"] !== "Ed25519") return fail(code);
  const completion: RecommendationCompletion = { schema_version: 1, source: "recommendation_worker",
    runtime_id: closedText(row["runtime_id"]), dispatch_receipt_id: closedText(row["dispatch_receipt_id"]),
    dispatch_receipt_digest: digest(row["dispatch_receipt_digest"], code),
    provider: provider(row["provider"], code), worktree_id: closedText(row["worktree_id"]),
    terminal_id: closedText(row["terminal_id"]), session_id: closedText(row["session_id"]),
    incarnation_id: closedText(row["incarnation_id"]), pty_id: closedText(row["pty_id"]),
    cursor: closedText(row["cursor"]), sequence: closedText(row["sequence"]), state: "completed",
    observed_at: task25Timestamp(row["observed_at"]), commit_digest: digest(row["commit_digest"], code),
    artifact_digest: digest(row["artifact_digest"], code), test_digest: digest(row["test_digest"], code),
    evidence_digest: digest(row["evidence_digest"], code), event_id: digest(row["event_id"], code),
    key_id: closedText(row["key_id"]), algorithm: "Ed25519", signature: signature(row["signature"], code) };
  const expectedEvent = persistenceHash(["recommendation-completion/v1", completion.runtime_id,
    completion.dispatch_receipt_id, completion.dispatch_receipt_digest, completion.provider,
    completion.worktree_id, completion.terminal_id, completion.session_id, completion.incarnation_id,
    completion.pty_id, completion.cursor, completion.sequence, completion.observed_at,
    completion.commit_digest, completion.artifact_digest, completion.test_digest, completion.evidence_digest]);
  const observed = Date.parse(completion.observed_at);
  if (completion.event_id !== expectedEvent || completion.cursor !== completion.sequence
    || observed > context.now.getTime() || context.now.getTime() - observed > 15 * 60_000
    || !validSignature(completionPayload(completion), completion.signature, COMPLETION_DOMAIN,
      context.publicKey)) return fail(code);
  return completion;
}
export type ParsedDispatchOutcome =
  | { readonly kind: "accepted"; readonly receipt: unknown }
  | { readonly kind: "not_sent"; readonly reason: string }
  | { readonly kind: "uncertain"; readonly reason: string };
export function parseDispatchOutcome(value: unknown): ParsedDispatchOutcome {
  const row = closedRecord(value); const kind = row["kind"];
  switch (kind) {
    case "accepted": return { kind, receipt: row["receipt"] };
    case "not_sent": return { kind, reason: closedText(row["reason"]) };
    case "uncertain": return { kind, reason: closedText(row["reason"]) };
    default: return fail("RECOMMENDATION_DISPATCH_OUTCOME_INVALID");
  }
}
