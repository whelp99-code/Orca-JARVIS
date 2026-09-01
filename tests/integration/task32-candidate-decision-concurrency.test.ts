import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { JarvisError } from "../../src/db.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import {
  MemoryCandidateReviewSpool,
  memoryCandidateReviewDigest,
  type MemoryCandidateReviewEnvelope,
} from "../../src/memory-candidate-review-spool.js";
import { MEMORY_NOW, inferredMemoryInput, memoryPolicy } from "../fixtures/memory-candidate-fixture.js";
import { memoryDatabase } from "../fixtures/memory-candidate-store.js";

const NOW = new Date(MEMORY_NOW);
const INTENT = `memui:intent:v1:${"1".repeat(64)}`;
const SUBJECT = "Owner summary preference";
const STATEMENT = "The owner may prefer concise technical summaries.";
const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;

/** Boots a real candidate awaiting owner confirmation with its review envelope published. */
async function awaitingConfirmation() {
  const database = await memoryDatabase();
  const reviewRoot = join(database.root, "candidate-review");
  const classification = new MemoryCandidateStore(
    database.authority, memoryPolicy(), () => NOW,
  ).classify(inferredMemoryInput({}));
  const core: Omit<MemoryCandidateReviewEnvelope, "review_envelope_digest"> = {
    schema_version: 1, candidate_id: classification.candidate_id,
    candidate_digest: classification.candidate_digest,
    classification_digest: classification.classification_digest,
    subject_digest: classification.subject_digest, content_digest: classification.content_digest,
    operation: "remember", subject: SUBJECT, statement: STATEMENT,
    purpose: "personal_memory", sensitivity: classification.policy_sensitivity,
    source_class: "labeled_inference", source_id: "inference-source-task27", source_version: "v1",
    policy_digest: classification.policy_digest,
    idempotency_key: `memidem:pos:v1:${hash("orca-jarvis/memory-write-idempotency/v1\0", {
      candidate_id: classification.candidate_id, candidate_digest: classification.candidate_digest,
      classification_digest: classification.classification_digest, operation: "remember",
    }).slice(7)}`,
    request_id: `memreq:pos:v1:${"2".repeat(64)}`, request_digest: `sha256:${"2".repeat(64)}`,
    retention_days: classification.retention_days, created_at: NOW.toISOString(),
    candidate_expires_at: classification.candidate_expires_at,
    confirmation_expires_at: classification.confirmation_expires_at ?? "",
  };
  new MemoryCandidateReviewSpool(reviewRoot).publish({
    ...core,
    review_envelope_digest: memoryCandidateReviewDigest({
      ...core, review_envelope_digest: `sha256:${"3".repeat(64)}`,
    }),
  });
  const session = createDashboardSession("owner-session");
  const service = new MemoryMutationService({
    authority: database.authority, tokens: new MemoryTokenCache(Buffer.alloc(32, 5), () => NOW),
    session, clock: () => NOW, candidate_review_spool_root: reviewRoot,
  });
  return { authority: database.authority, service, candidateId: classification.candidate_id };
}

describe("Task 32 candidate decision concurrency", () => {
  it("collapses a same-decision replay onto one semantic family attempt", async () => {
    // Given a candidate awaiting owner confirmation
    const { authority, service, candidateId } = await awaitingConfirmation();
    const decision = { candidate_id: candidateId, operation: "remember", decision: "confirm",
      intent_id: INTENT } as const;
    // When the same confirmation is staged twice
    const first = service.stageCandidateDecision(decision);
    const replay = service.stageCandidateDecision(decision);
    // Then both resolve to a single generation-1 attempt
    expect(first?.request_id).toBeDefined();
    expect(replay?.request_id).toBe(first?.request_id);
    expect(authority.db.prepare(
      "SELECT attempt_generation,predecessor_attempt_id FROM memory_candidate_decision_attempts",
    ).all()).toEqual([{ attempt_generation: 1, predecessor_attempt_id: null }]);
    authority.close();
  });

  it("refuses a contradicting decision while an attempt is still staged", async () => {
    // Given a candidate whose confirmation is already staged
    const { authority, service, candidateId } = await awaitingConfirmation();
    service.stageCandidateDecision({ candidate_id: candidateId, operation: "remember",
      decision: "confirm", intent_id: INTENT });
    // When the opposite decision races the staged one
    const contradiction = () => service.stageCandidateDecision({ candidate_id: candidateId,
      operation: "remember", decision: "reject", intent_id: INTENT });
    // Then it is rejected as a state conflict and no second family is created
    expect(contradiction).toThrow(JarvisError);
    expect(authority.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decision_families",
    ).get()).toEqual({ count: 1 });
    authority.close();
  });
});
