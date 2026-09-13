import { afterEach, expect, it } from "vitest";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MorningRecommendationSource } from "../../src/morning-recommendation-source.js";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { contextMemoryFromReference, ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { produceDailyRecommendation } from "../../src/personal-context-production.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import { recordCandidateTaskSource } from "../../src/memory-candidate-task-source.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, persistLocalChainLiveObservation,
  LOCAL_CHAIN_AT,
} from "../fixtures/local-observation-chain.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { MemoryReferenceProvider, REFERENCE_NOW, REFERENCE_RECORD, REFERENCE_GENERATION }
  from "../fixtures/memory-reference-provider.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";

const TASK = "task:reference-seam";
const NOW = new Date(MEMORY_NOW);
const BUDGETS = { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 };
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

async function seam() {
  const database = await memoryDatabase();
  open.push(database);
  const authority = database.authority;
  const provider = new MemoryReferenceProvider();
  const { config } = memoryReadFenceFixture(database);
  const runtime = createProductionMemoryReference(authority, { transport: provider,
    read_fence_config: config, projection_key: Buffer.alloc(32, 7), clock: () => REFERENCE_NOW });
  return { database, authority, provider, runtime };
}

/** The convention this product's own tests use for a target it resolved earlier. */
function seedResolvedTarget(authority: MemoryDatabase["authority"], contentIdentity: string): void {
  authority.db.prepare(
    `INSERT INTO memory_resolved_target_metadata(
      target_id,target_digest,provider_instance_id,generation_id,generation_manifest_digest,
      page_content_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
      keyed_subject_digest,sensitivity,source_owner_class,source_owner_id_digest,resolved_at,
      expires_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("sbtarget:v1:seam", `sha256:${"e".repeat(64)}`, REFERENCE_GENERATION.provider_instance_id,
    REFERENCE_GENERATION.generation_id, REFERENCE_GENERATION.generation_manifest_digest,
    `sha256:${"f".repeat(64)}`, `sha256:${REFERENCE_RECORD.source_identity_full}`,
    `sha256:${contentIdentity}`, `sha256:${REFERENCE_RECORD.citation_identity_full}`,
    `sha256:${"1".repeat(64)}`, "personal", "provider_owned", `sha256:${"2".repeat(64)}`,
    "2026-08-31T00:00:00.000Z", "2026-09-30T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
}

// The read contract says what it is: its payload carries trust "untrusted" and authority "none", and
// its own documentation says it builds reference data and never a confirmed fact. So a record this
// database cannot name contributes nothing, and the production path has no principle to rest on.
it("contributes nothing from a verified read whose identity this database cannot name", async () => {
  const f = await seam();
  const reference = await f.runtime.reader.read("기억", BUDGETS);
  expect(reference.payload.records.length).toBeGreaterThan(0);

  const memories = contextMemoryFromReference(f.authority, reference);
  expect(memories.map(item => item.kind)).toEqual(reference.payload.records.map(() => "gap"));
  expect(memories.every(item => item.kind === "gap" && item.state === "no_data")).toBe(true);
});

// Naming the identity is not permission to use it. With the target resolved and no confirmation on
// record, the same record is still a gap, and the production path abstains without writing.
it("still refuses a named identity the owner never confirmed, and abstains without writing", async () => {
  const f = await seam();
  seedResolvedTarget(f.authority, REFERENCE_RECORD.content_identity_full);
  const reference = await f.runtime.reader.read("기억", BUDGETS);
  const memories = contextMemoryFromReference(f.authority, reference);
  expect(memories.every(item => item.kind === "gap")).toBe(true);
  expect(ownerConfirmedContent(f.authority, `sha256:${REFERENCE_RECORD.content_identity_full}`)).toBe(false);

  await admitLocalChainObservation(f.authority, LOCAL_CHAIN_AT);
  const live = persistLocalChainLiveObservation(f.authority, 0, LOCAL_CHAIN_AT);
  const owner = approveLocalChainOwnerDecisions(f.authority, 0, LOCAL_CHAIN_AT);
  const produced = produceDailyRecommendation(f.authority, {
    assemble: { purpose: "daily_prioritization", query: "what now?", clock: LOCAL_CHAIN_AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 256, max_total_bytes: 4096 },
      observations: [live.observation], pending_authority_refs: [], memories } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: REFERENCE_RECORD.record_id, owner_import_decision_ref: owner.importDecision.request_id,
    candidates: [{ action_id: "reference-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: owner.ownerGate.request_id,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: REFERENCE_RECORD.record_id,
      current_evidence_ref: live.id, stable_identity: { key: "reference-followup", evidence_ref: live.id } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7e01",
      idempotency_key: `idem:pos:v1:recommendation:${"e".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "reference-followup", title: "Next: reference-followup",
        operation: "review", target_digest: `sha256:${"a".repeat(64)}` }] },
  });

  expect(produced.state).toBe("abstained");
  expect(Number(f.authority.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
  expect(projectRecommendations(f.authority, LOCAL_CHAIN_AT).next_actions).toEqual([]);
  expect(new MorningRecommendationSource(f.authority).generate(LOCAL_CHAIN_AT).brief.abstention_reasons)
    .toEqual(["no_data"]);
}, 60_000);

// Why the positive control cannot be built yet, measured rather than asserted: a provider record's
// content identity and a local candidate's content digest are produced by different functions, so
// nothing joins the record the provider returned to the candidate the owner confirmed. Until the
// write path records that correspondence there is no input whose trust this database can prove,
// which is also why memoriesAwaitingTaskWithdrawal resolves no target for such a memory.
it("has no correspondence between a provider record identity and a confirmed candidate", async () => {
  const f = await seam();
  const store = new MemoryCandidateStore(f.authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(`${f.database.root}/review`);
  const candidate = store.classify(inferredMemoryInput({ sensitivity: "personal" }));
  recordCandidateTaskSource(f.authority, candidate.candidate_id, TASK, NOW);
  const contentDigest = String(f.authority.db
    .prepare("SELECT content_digest FROM memory_candidates WHERE candidate_id=?")
    .pluck().get(candidate.candidate_id));

  expect(contentDigest).not.toBe(`sha256:${REFERENCE_RECORD.content_identity_full}`);
  seedResolvedTarget(f.authority, REFERENCE_RECORD.content_identity_full);
  new MemoryProjectionAuthority(f.authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

  // Closure is asked of the provider identity and finds no candidate under it, so hiding the task
  // cannot change this record's answer - it was never usable in the first place.
  const reference = await f.runtime.reader.read("기억", BUDGETS);
  const memories = contextMemoryFromReference(f.authority, reference);
  expect(memories.every(item => item.kind === "gap" && item.state === "no_data")).toBe(true);
}, 60_000);
