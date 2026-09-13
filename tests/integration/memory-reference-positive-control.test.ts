import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { prepareMemoryReference } from "../../src/memory-reference-context.js";
import { contextMemoryFromReference, ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { evidence, FixtureReader, FixtureWriter, OUTBOX_ARTIFACT_DIGEST } from "../fixtures/memory-outbox-fixture.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { MemoryReferenceProvider, REFERENCE_GENERATION, REFERENCE_RECORD,
  REFERENCE_TARGET } from "../fixtures/memory-reference-provider.js";
import { localKey } from "../helpers.js";

const NOW = new Date(MEMORY_NOW);
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });

function reference() {
  const bound = { ...evidence(OUTBOX_ARTIFACT_DIGEST),
    record: { ...REFERENCE_RECORD, generation: REFERENCE_GENERATION } };
  return prepareMemoryReference({ query: "example", budgets: BUDGETS, now: NOW,
    outcome: { kind: "current", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
      evidence: [bound] } as never });
}

// The positive control the refusals are measured against: a candidate the owner really confirmed,
// through the staging the dashboard uses and a receipt the owner signed, then written and settled.
it("accepts a record from a settled write the owner confirmed, through the real confirmation", async () => {
  const database = await memoryDatabase();
  databases.push(database);
  const authority = database.authority;
  const reviewRoot = join(database.root, "review");
  const dispatchRoot = join(database.root, "dispatch");
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const candidate = store.classify(inferredMemoryInput({ subject: "wiki/example-alpha", statement: "ExampleAlpha" }));

  const mutation = new MemoryMutationService({ authority, clock: () => NOW,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => NOW),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const command = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"1".repeat(64)}` });
  if (command === undefined) throw new Error("confirmation command required");
  const control = new ControlPlane(authority);
  control.decide(signCommandApproval({ schema_version: 1, receipt_id: "seam-confirmation",
    request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: MEMORY_NOW, not_before: MEMORY_NOW,
    expires_at: command.expires_at, nonce: "seam-confirmation", max_uses: 1, status: "issued" },
  localKey(authority)), NOW);

  const contentDigest = String(authority.db
    .prepare("SELECT content_digest FROM memory_candidates WHERE candidate_id=?")
    .pluck().get(candidate.candidate_id));
  // The owner's confirmation is on record now, which none of the refusal cases had.
  expect(ownerConfirmedContent(authority, contentDigest)).toBe(true);

  // Write it, and let the reconciliation observe the artifact, so the outbox names the destination.
  const dispatch = new MemoryCandidateDispatchSpool(dispatchRoot).read(candidate.candidate_id);
  const actionId = "seam-outbox-action";
  const action = { schema_version: 1 as const, request_id: actionId, action: "memory.outbox.dispatch",
    action_level: 3 as const, target: { candidate_id: candidate.candidate_id,
      candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest },
    args: { schema_version: 2, dispatch_spool_digest: dispatch.dispatch_spool_digest,
      expected_artifact: { page_id: "wiki/example-alpha", sid: "12345678", source_digest: OUTBOX_ARTIFACT_DIGEST } },
    reversible: false, requested_by: "principal:owner", requested_at: MEMORY_NOW,
    expires_at: new Date(NOW.getTime() + 900_000).toISOString(), nonce: "seam-outbox-action-nonce" };
  const staged = control.stage(action, NOW);
  control.decide(signCommandApproval({ schema_version: 1, receipt_id: "seam-outbox-approval",
    request_id: actionId, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "owner-session",
    key_id: "decision-test", algorithm: "Ed25519", issued_at: MEMORY_NOW, not_before: MEMORY_NOW,
    expires_at: action.expires_at, nonce: "seam-outbox-receipt-nonce", max_uses: 1, status: "issued" },
  localKey(authority)), NOW);

  const service = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
    reader: new FixtureReader({ kind: "current", checked_at: MEMORY_NOW,
      evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }), clock: () => NOW,
    artifactDeadlineMs: 30_000, leaseMs: 10_000,
    candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
  const claimed = control.claim(actionId, "seam-worker", NOW);
  const queued = service.enqueue(claimed);
  expect(await service.runOnce("seam-worker", 1)).toMatchObject({ settled: 1 });
  expect(service.get(queued.outbox_id)).toMatchObject({ state: "settled" });

  // An artifact resting on this memory has to stay suppressible, so the target identity behind the
  // record is resolved from the provider through the product's own effect service first.
  const effect = new SecondBrainEffectService({ authority, transport: new MemoryReferenceProvider(),
    writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
    provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
    signing_key_id: "memory-effect-positive-control",
    private_key: generateKeyPairSync("ed25519").privateKey });
  expect(await effect.resolveTarget({ record_id: REFERENCE_RECORD.record_id,
    record_digest: REFERENCE_RECORD.record_digest, generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest }))
    .toMatchObject({ kind: "data" });

  // Identity, closure, confirmation and that resolved target all answer, so the record becomes
  // evidence rather than a gap, and it is named by the identity a forget would reach it through.
  const memories = contextMemoryFromReference(authority, reference());
  expect(memories).toEqual([{ kind: "evidence", memory_ref: REFERENCE_TARGET.target_id,
    source_id: "src:pos:v1:second-brain:primary", digest: contentDigest,
    observed_at: expect.any(String), fresh_until: expect.any(String), excerpt: expect.any(String),
    trust: "user_confirmed", sensitivity: "personal", relevance: "related", relation: "supports" }]);
}, 60_000);
