import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalize } from "../../src/canonical.js";
import {
  ControlPlane,
  MemoryCandidateDispatchSpool,
  MemoryCandidateReviewSpool,
  MemoryCandidateStore,
  memoryCandidateWriteReceipt,
  MemoryOutboxService,
  signCommandApproval,
  type CommandApprovalReceipt,
  type ControlCommandRequestInput,
  type SecondBrainEvidence,
  type SecondBrainReadAdapter,
  type SecondBrainReadOutcome,
  type SecondBrainWriteOutcome,
  type SecondBrainWriteRequestAdapter,
  type SecondBrainWriteRequestV1,
} from "../../src/index.js";
import { localKey } from "../helpers.js";
import { MEMORY_NOW, memoryPolicy, verifiedMemoryInput } from "./memory-candidate-fixture.js";
import { insertMemoryVerification, memoryDatabase, memoryVerificationPayload, type MemoryDatabase } from "./memory-candidate-store.js";
import type { MemoryCandidateReviewEnvelope } from "../../src/memory-candidate-review-spool.js";
import { memoryCandidateReviewDigest } from "../../src/memory-candidate-review-spool.js";

export const OUTBOX_NOW = new Date("2026-08-31T03:30:00.000Z");
export const OUTBOX_EXPIRES = "2026-09-01T03:30:00.000Z";
export const OUTBOX_ACTION_EXPIRES = "2026-08-31T03:45:00.000Z";
export const OUTBOX_ARTIFACT_LINE = "ExampleAlpha.[^12345678]";
export const OUTBOX_ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(OUTBOX_ARTIFACT_LINE).digest("hex")}`;
const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
export class FixtureWriter implements SecondBrainWriteRequestAdapter {
  calls: SecondBrainWriteRequestV1[] = [];
  constructor(readonly kind: "accepted" | "uncertain" = "accepted") {}
  write(request: unknown): Promise<SecondBrainWriteOutcome> {
    const value = request as SecondBrainWriteRequestV1; this.calls.push(value);
    if (this.kind === "uncertain") return Promise.resolve({ kind: "uncertain", code: "SECOND_BRAIN_WRITE_INTERRUPTED" });
    return Promise.resolve({ kind: "accepted", state: "pending", candidate_id: value.candidate_id,
      request_id: value.request_id, request_digest: value.request_digest, idempotency_key: value.idempotency_key,
      operation: value.operation, accepted_at: OUTBOX_NOW.toISOString(), inbox_path: `inbox/.requests/pending/${value.request_id}.json`,
      request_file_digest: `sha256:${"4".repeat(64)}`, replayed: false });
  }
}
export class FixtureReader implements SecondBrainReadAdapter {
  recentCalls = 0; pageCalls = 0;
  constructor(readonly outcome: SecondBrainReadOutcome) {}
  search(): Promise<SecondBrainReadOutcome> { return Promise.resolve(this.outcome); }
  readPage(): Promise<SecondBrainReadOutcome> { this.pageCalls += 1; return Promise.resolve(this.outcome); }
  recentChanges(): Promise<SecondBrainReadOutcome> { this.recentCalls += 1; return Promise.resolve(this.outcome); }
  openConflicts(): Promise<SecondBrainReadOutcome> { return Promise.resolve(this.outcome); }
}
export const missingReader = (): FixtureReader => new FixtureReader({ kind: "no_data", checked_at: MEMORY_NOW,
  fresh_until: "2026-08-28T12:01:00.000Z" });
export function evidence(digest: string, sid = "12345678"): SecondBrainEvidence {
  return { kind: "memory", page_id: "wiki/example-alpha", sid, source_ref: "synthetic:ExampleAlpha",
    source_id: "src:pos:v1:second-brain:primary", source_version: "sb/0.1.0|v1|fixture",
    sensitivity: "personal", observed_at: MEMORY_NOW, valid_at: MEMORY_NOW,
    freshness: { state: "fresh", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z" },
    expires_at: "2026-08-29T12:00:00.000Z", trust: "untrusted", authority: "none",
    excerpt: OUTBOX_ARTIFACT_LINE, content_digest: digest, omission: null, record: null };
}
export type OutboxFixture = { database: MemoryDatabase; service: MemoryOutboxService; writer: FixtureWriter;
  reader: FixtureReader; request: SecondBrainWriteRequestV1; commandId: string; digest: string; clock: { now: Date } };
export async function outboxFixture(options: { writer?: FixtureWriter; reader?: FixtureReader; deadline?: number } = {}): Promise<OutboxFixture> {
  const database = await memoryDatabase();
  const input = verifiedMemoryInput({ subject: "wiki/example-alpha", statement: "ExampleAlpha" });
  insertMemoryVerification(database.authority, memoryVerificationPayload(input, {
    issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(), expires_at: OUTBOX_EXPIRES,
  }));
  const classification = new MemoryCandidateStore(database.authority, memoryPolicy(), () => OUTBOX_NOW).classify(input);
  const reviewCore: Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest"> = {
    schema_version: 1, candidate_id: classification.candidate_id,
    candidate_digest: classification.candidate_digest, classification_digest: classification.classification_digest,
    subject_digest: classification.subject_digest, content_digest: classification.content_digest,
    operation: "remember", subject: "wiki/example-alpha", statement: "ExampleAlpha",
    purpose: "personal_memory", sensitivity: classification.policy_sensitivity,
    source_class: "verified_outcome", source_id: "verified-source-outbox", source_version: "v1",
    policy_digest: classification.policy_digest,
    idempotency_key: `memidem:pos:v1:${hash("orca-jarvis/memory-write-idempotency/v1\0", {
      candidate_id: classification.candidate_id, candidate_digest: classification.candidate_digest,
      classification_digest: classification.classification_digest, operation: "remember",
    }).slice(7)}`,
    request_id: `memreq:pos:v1:${"2".repeat(64)}`, request_digest: `sha256:${"2".repeat(64)}`,
    retention_days: classification.retention_days, created_at: OUTBOX_NOW.toISOString(),
    candidate_expires_at: OUTBOX_EXPIRES, confirmation_expires_at: OUTBOX_EXPIRES,
  };
  const review: MemoryCandidateReviewEnvelope = {
    ...reviewCore, review_envelope_digest: memoryCandidateReviewDigest({
      ...reviewCore, review_envelope_digest: `sha256:${"3".repeat(64)}`,
    }),
  };
  const reviewRoot = join(database.root, "candidate-review");
  const dispatchRoot = join(database.root, "candidate-dispatch");
  new MemoryCandidateReviewSpool(reviewRoot).publish(review);
  const dispatchSpool = new MemoryCandidateDispatchSpool(dispatchRoot);
  dispatchSpool.publish(review, {
    control_request_id: "candidate-confirmation", control_receipt_id: "candidate-receipt",
    command_digest: `sha256:${"4".repeat(64)}`, issued_at: OUTBOX_NOW.toISOString(),
    principal_id: "principal:owner", expires_at: OUTBOX_EXPIRES, decision: "auto_staged",
  });
  const dispatch = dispatchSpool.read(review.candidate_id);
  const providerReceipt = memoryCandidateWriteReceipt(dispatch);
  const requestBase = { schema_version: 1 as const, candidate_id: dispatch.candidate_id,
    candidate_digest: dispatch.candidate_digest, classification_digest: dispatch.classification_digest,
    idempotency_key: dispatch.idempotency_key, operation: dispatch.operation, subject: review.subject,
    purpose: dispatch.purpose, sensitivity: dispatch.sensitivity, retention_days: dispatch.retention_days,
    created_at: dispatch.created_at, expires_at: dispatch.expires_at, expected_prior: null,
    receipt: providerReceipt, receipt_digest: dispatch.receipt_digest, payload: { content: review.statement } };
  const request: SecondBrainWriteRequestV1 = { ...requestBase, request_id: dispatch.request_id,
    request_digest: dispatch.request_digest };
  const sourceDigest = OUTBOX_ARTIFACT_DIGEST; const commandId = "memory-outbox-action";
  const action: ControlCommandRequestInput = { schema_version: 1, request_id: commandId, action: "memory.outbox.dispatch",
    action_level: 3, target: { candidate_id: classification.candidate_id, candidate_digest: classification.candidate_digest,
      classification_digest: classification.classification_digest }, args: { schema_version: 2,
      dispatch_spool_digest: dispatch.dispatch_spool_digest,
      expected_artifact: { page_id: "wiki/example-alpha", sid: "12345678", source_digest: sourceDigest } },
    reversible: false, requested_by: "principal:owner", requested_at: OUTBOX_NOW.toISOString(),
    expires_at: OUTBOX_ACTION_EXPIRES, nonce: "memory-outbox-action-nonce" };
  const control = new ControlPlane(database.authority); const staged = control.stage(action, OUTBOX_NOW);
  const unsigned: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: "memory-outbox-approval",
    request_id: commandId, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: OUTBOX_NOW.toISOString(), not_before: OUTBOX_NOW.toISOString(), expires_at: action.expires_at,
    nonce: "memory-outbox-action-receipt-nonce", max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(unsigned, localKey(database.authority)), OUTBOX_NOW);
  const writer = options.writer ?? new FixtureWriter(); const reader = options.reader ?? missingReader(); const clock = { now: OUTBOX_NOW };
  const service = new MemoryOutboxService({ authority: database.authority, writer, reader, clock: () => clock.now,
    artifactDeadlineMs: options.deadline ?? 30_000, leaseMs: 10_000,
    candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
  return { database, service, writer, reader, request, commandId, digest: sourceDigest, clock };
}
export function claimAction(value: OutboxFixture) {
  return new ControlPlane(value.database.authority).claim(value.commandId, "approved-command-executor", value.clock.now);
}
