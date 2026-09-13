import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { stageMemoryRememberDispatch } from "../../src/memory-remember-dispatch.js";
import { publishAutomaticMemoryCandidate } from "../../src/memory-auto-publication.js";
import { prepareMemoryReference } from "../../src/memory-reference-context.js";
import { contextMemoryFromReference, ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import {
  inferredMemoryInput, verifiedMemoryInput, memoryPolicy, MEMORY_NOW,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase, insertMemoryVerification, memoryDatabase, memoryVerificationPayload,
  type MemoryDatabase,
} from "../fixtures/memory-candidate-store.js";
import { FixtureReader, FixtureWriter } from "../fixtures/memory-outbox-fixture.js";
import { rememberArtifact } from "../fixtures/memory-remember-settlement.js";
import {
  MemoryReferenceProvider, REFERENCE_GENERATION,
} from "../fixtures/memory-reference-provider.js";
import { localKey } from "../helpers.js";

const NOW = new Date(MEMORY_NOW);
const SUBJECT = "wiki/shared-statement";
const STATEMENT = "SharedStatement";
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });

/**
 * A confirmation is of a candidate, not of a sentence.
 *
 * Two candidates can carry the same statement and reach the provider by different roads. One asked
 * the owner and they said yes. The other needed no confirmation at all, was approved automatically,
 * and its write is the one that landed on the page a record came back on. Reading the owner's answer
 * by content lets the second borrow the first's permission - and the owner is then shown, as a
 * confirmed principle, something they never confirmed.
 */
it("refuses a settled write the owner never confirmed, even when the same words were confirmed elsewhere", async () => {
  const database = await memoryDatabase();
  databases.push(database);
  const authority = database.authority;
  const reviewRoot = `${database.root}/review`;
  const dispatchRoot = `${database.root}/dispatch`;
  const roots = { candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot };
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const control = new ControlPlane(authority);
  const sign = (receiptId: string, requestId: string, digest: string, expiresAt: string) =>
    signCommandApproval({ schema_version: 1, receipt_id: receiptId, request_id: requestId,
      decision: "approve", command_digest: digest, signer_principal_id: "principal:owner",
      authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: MEMORY_NOW, not_before: MEMORY_NOW, expires_at: expiresAt, nonce: receiptId,
      max_uses: 1, status: "issued" }, localKey(authority));

  // The candidate the owner was actually asked about, and answered.
  const asked = store.classify(inferredMemoryInput({ subject: SUBJECT, statement: STATEMENT,
    idempotency_key: "candidate:shared:asked" }));
  const mutation = new MemoryMutationService({ authority, clock: () => NOW,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => NOW),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const confirmation = mutation.stageCandidateDecision({ candidate_id: asked.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"5".repeat(64)}` });
  if (confirmation === undefined) throw new Error("confirmation command required");
  control.decide(sign("shared-confirmation", confirmation.request_id, confirmation.command_digest,
    confirmation.expires_at), NOW);

  // A different candidate carrying the same words, which needed no confirmation and got none.
  const unaskedInput = verifiedMemoryInput({ subject: SUBJECT, statement: STATEMENT,
    idempotency_key: "candidate:shared:unasked", authority_id: "shared" });
  insertMemoryVerification(authority, memoryVerificationPayload(unaskedInput,
    { issued_at: MEMORY_NOW, not_before: MEMORY_NOW, expires_at: "2026-08-29T12:00:00.000Z" }));
  const unasked = store.classify(unaskedInput);
  expect(unasked.candidate_id).not.toBe(asked.candidate_id);
  expect(String(unasked.content_digest)).toBe(String(asked.content_digest));
  expect(Number(authority.db.prepare("SELECT required_confirmation FROM memory_candidates WHERE candidate_id=?")
    .pluck().get(unasked.candidate_id))).toBe(0);

  // The write that actually landed is the unasked one's, published the way the intake command
  // publishes approved material that needed no confirmation.
  publishAutomaticMemoryCandidate(authority, unaskedInput, memoryPolicy(), roots, () => NOW);
  const staged = stageMemoryRememberDispatch(authority, unasked.candidate_id, NOW, roots);
  control.decide(sign("shared-dispatch", staged.request_id, staged.command_digest, staged.expires_at), NOW);
  const settlement = rememberArtifact({ candidate_id: unasked.candidate_id, statement: STATEMENT,
    sensitivity: "personal", observed_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
    expires_at: "2026-08-29T12:00:00.000Z" });
  const service = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
    reader: new FixtureReader({ kind: "current", checked_at: MEMORY_NOW, evidence: [...settlement.evidence] }),
    clock: () => NOW, artifactDeadlineMs: 30_000, leaseMs: 10_000,
    candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
  const queued = service.enqueue(control.claim(staged.request_id, "shared-worker", NOW));
  expect(await service.runOnce("shared-worker", 1)).toMatchObject({ settled: 1 });
  expect(service.get(queued.outbox_id)).toMatchObject({ state: "settled" });

  // Everything else the seam asks for is in place, so the confirmation is the only question left.
  const record = settlement.evidence[0]?.record;
  if (record === null || record === undefined) throw new Error("settled record required");
  const page = { page_id: settlement.page_id, record: record as unknown as Record<string, unknown> };
  const effect = new SecondBrainEffectService({ authority, transport: new MemoryReferenceProvider(page),
    writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
    provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
    signing_key_id: "memory-effect-shared", private_key: generateKeyPairSync("ed25519").privateKey });
  expect(await effect.resolveTarget({ record_id: String(record.record_id),
    record_digest: String(record.record_digest), generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest }))
    .toMatchObject({ kind: "data" });

  // The content is confirmed - by the other candidate. This write is not.
  expect(ownerConfirmedContent(authority, String(unasked.content_digest))).toBe(true);
  const reference = prepareMemoryReference({ query: "shared", budgets: BUDGETS, now: NOW,
    outcome: { kind: "current", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
      evidence: [...settlement.evidence] } as never });
  expect(contextMemoryFromReference(authority, reference))
    .toEqual([{ kind: "gap", memory_ref: String(record.record_id), state: "no_data" }]);
}, 60_000);

/**
 * A destination identifies one candidate, and the seam answers for that one.
 *
 * The page a remember write lands on is derived from the candidate and its content, so two writes of
 * ours cannot share one - and the record that came back on a page has to resolve to the candidate
 * whose write put it there, not to whichever row the database happened to return first.
 */
it("resolves each settled destination to its own candidate", async () => {
  const database = await memoryDatabase();
  databases.push(database);
  const authority = database.authority;
  const reviewRoot = `${database.root}/review`;
  const dispatchRoot = `${database.root}/dispatch`;
  const roots = { candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot };
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const control = new ControlPlane(authority);
  const sign = (receiptId: string, requestId: string, digest: string, expiresAt: string) =>
    signCommandApproval({ schema_version: 1, receipt_id: receiptId, request_id: requestId,
      decision: "approve", command_digest: digest, signer_principal_id: "principal:owner",
      authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: MEMORY_NOW, not_before: MEMORY_NOW, expires_at: expiresAt, nonce: receiptId,
      max_uses: 1, status: "issued" }, localKey(authority));
  const mutation = new MemoryMutationService({ authority, clock: () => NOW,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => NOW),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });

  const settle = async (statement: string, key: string) => {
    const candidate = store.classify(inferredMemoryInput({ subject: SUBJECT, statement, idempotency_key: key }));
    const confirmation = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
      operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"6".repeat(64)}` });
    if (confirmation === undefined) throw new Error("confirmation command required");
    control.decide(sign(`confirm:${key}`, confirmation.request_id, confirmation.command_digest,
      confirmation.expires_at), NOW);
    const staged = stageMemoryRememberDispatch(authority, candidate.candidate_id, NOW, roots);
    control.decide(sign(`dispatch:${key}`, staged.request_id, staged.command_digest, staged.expires_at), NOW);
    const settlement = rememberArtifact({ candidate_id: candidate.candidate_id, statement,
      sensitivity: "personal", observed_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
      expires_at: "2026-08-29T12:00:00.000Z" });
    const service = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
      reader: new FixtureReader({ kind: "current", checked_at: MEMORY_NOW, evidence: [...settlement.evidence] }),
      clock: () => NOW, artifactDeadlineMs: 30_000, leaseMs: 10_000,
      candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
    service.enqueue(control.claim(staged.request_id, `worker:${key}`, NOW));
    expect(await service.runOnce(`worker:${key}`, 1)).toMatchObject({ settled: 1 });
    const record = settlement.evidence[0]?.record;
    if (record === null || record === undefined) throw new Error("settled record required");
    const page = { page_id: settlement.page_id, record: record as unknown as Record<string, unknown> };
    const effect = new SecondBrainEffectService({ authority, transport: new MemoryReferenceProvider(page),
      writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
      provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
      signing_key_id: `memory-effect:${key}`, private_key: generateKeyPairSync("ed25519").privateKey });
    expect(await effect.resolveTarget({ record_id: String(record.record_id),
      record_digest: String(record.record_digest), generation_id: REFERENCE_GENERATION.generation_id,
      generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest }))
      .toMatchObject({ kind: "data" });
    const reference = prepareMemoryReference({ query: statement, budgets: BUDGETS, now: NOW,
      outcome: { kind: "current", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
        evidence: [...settlement.evidence] } as never });
    return { candidate, settlement, reference };
  };

  const first = await settle("FirstStatement", "candidate:destination:first");
  const second = await settle("SecondStatement", "candidate:destination:second");
  expect(first.settlement.page_id).not.toBe(second.settlement.page_id);

  // Each record is answered for by the candidate whose write landed on that page, and by no other.
  expect(contextMemoryFromReference(authority, first.reference))
    .toEqual([expect.objectContaining({ kind: "evidence", digest: String(first.candidate.content_digest) })]);
  expect(contextMemoryFromReference(authority, second.reference))
    .toEqual([expect.objectContaining({ kind: "evidence", digest: String(second.candidate.content_digest) })]);
}, 60_000);
