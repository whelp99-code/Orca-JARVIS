import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { stageMemoryRememberDispatch } from "../../src/memory-remember-dispatch.js";
import { prepareMemoryReference } from "../../src/memory-reference-context.js";
import { contextMemoryFromReference, ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { FixtureReader, FixtureWriter } from "../fixtures/memory-outbox-fixture.js";
import { rememberArtifact } from "../fixtures/memory-remember-settlement.js";
import { localKey } from "../helpers.js";
import {
  MemoryReferenceProvider, referenceTargetFor, REFERENCE_GENERATION,
} from "../fixtures/memory-reference-provider.js";

const NOW = new Date(MEMORY_NOW);
const STATEMENT = "ExampleAlpha";
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });

// The positive control the refusals are measured against: a candidate the owner really confirmed,
// through the staging the dashboard uses and a receipt the owner signed, then written and settled
// through the product's own dispatch path - which is what decides where the write goes. The page and
// section below are never chosen here; they are read back from what that path derived.
it("accepts a record from a settled write the owner confirmed, through the real confirmation", async () => {
  const database = await memoryDatabase();
  databases.push(database);
  const authority = database.authority;
  const reviewRoot = join(database.root, "review");
  const dispatchRoot = join(database.root, "dispatch");
  const roots = { candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot };
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const candidate = store.classify(inferredMemoryInput({ subject: "wiki/example-alpha", statement: STATEMENT }));

  const mutation = new MemoryMutationService({ authority, clock: () => NOW,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => NOW),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const command = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"1".repeat(64)}` });
  if (command === undefined) throw new Error("confirmation command required");
  const control = new ControlPlane(authority);
  const sign = (receiptId: string, requestId: string, digest: string, expiresAt: string) =>
    signCommandApproval({ schema_version: 1, receipt_id: receiptId, request_id: requestId,
      decision: "approve", command_digest: digest, signer_principal_id: "principal:owner",
      authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: MEMORY_NOW, not_before: MEMORY_NOW, expires_at: expiresAt, nonce: receiptId,
      max_uses: 1, status: "issued" }, localKey(authority));
  control.decide(sign("seam-confirmation", command.request_id, command.command_digest, command.expires_at), NOW);

  const contentDigest = String(authority.db
    .prepare("SELECT content_digest FROM memory_candidates WHERE candidate_id=?")
    .pluck().get(candidate.candidate_id));
  // The owner's confirmation is on record now, which none of the refusal cases had.
  expect(ownerConfirmedContent(authority, contentDigest)).toBe(true);

  // The dispatch is prepared and staged by the product, so the destination is derived from the
  // candidate and its content rather than chosen here. A test-chosen page would prove nothing about
  // where a real write lands, and the seam binds to the derived one.
  const staged = stageMemoryRememberDispatch(authority, candidate.candidate_id, NOW, roots);
  expect(staged.action).toBe("memory.outbox.dispatch");
  const settlement = rememberArtifact({ candidate_id: candidate.candidate_id, statement: STATEMENT,
    sensitivity: "personal", observed_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
    expires_at: "2026-08-29T12:00:00.000Z" });
  expect(staged.args).toMatchObject({ expected_artifact: { page_id: settlement.page_id, sid: settlement.sid } });
  control.decide(sign("seam-outbox-approval", staged.request_id, staged.command_digest, staged.expires_at), NOW);

  const service = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
    reader: new FixtureReader({ kind: "current", checked_at: MEMORY_NOW, evidence: [...settlement.evidence] }),
    clock: () => NOW, artifactDeadlineMs: 30_000, leaseMs: 10_000,
    candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
  const queued = service.enqueue(control.claim(staged.request_id, "seam-worker", NOW));
  expect(await service.runOnce("seam-worker", 1)).toMatchObject({ settled: 1 });
  expect(service.get(queued.outbox_id)).toMatchObject({ state: "settled" });

  // An artifact resting on this memory has to stay suppressible, so the target identity behind the
  // record is resolved from the provider through the product's own effect service first.
  const record = settlement.records[0];
  if (record === undefined) throw new Error("settled record required");
  const page = { page_id: settlement.page_id, record };
  const effect = new SecondBrainEffectService({ authority, transport: new MemoryReferenceProvider(page),
    writer: { write: () => Promise.reject(new Error("fixture performs no write")) }, clock: () => NOW,
    provider_instance_id: REFERENCE_GENERATION.provider_instance_id,
    signing_key_id: "memory-effect-positive-control",
    private_key: generateKeyPairSync("ed25519").privateKey });
  expect(await effect.resolveTarget({ record_id: String(record.record_id),
    record_digest: String(record.record_digest), generation_id: REFERENCE_GENERATION.generation_id,
    generation_manifest_digest: REFERENCE_GENERATION.generation_manifest_digest }))
    .toMatchObject({ kind: "data" });

  // Identity, closure, confirmation and that resolved target all answer, so the record becomes
  // evidence rather than a gap, and it is named by the identity a forget would reach it through.
  const reference = prepareMemoryReference({ query: "example", budgets: BUDGETS, now: NOW,
    outcome: { kind: "current", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T13:00:00.000Z",
      evidence: [...settlement.evidence] } as never });
  expect(reference.payload.records).toHaveLength(1);
  const memories = contextMemoryFromReference(authority, reference);
  expect(memories).toEqual([{ kind: "evidence", memory_ref: referenceTargetFor(page)["target_id"],
    source_id: "src:pos:v1:second-brain:primary", digest: contentDigest,
    observed_at: expect.any(String), fresh_until: expect.any(String), excerpt: expect.any(String),
    trust: "user_confirmed", sensitivity: "personal", relevance: "related", relation: "supports" }]);
}, 60_000);
