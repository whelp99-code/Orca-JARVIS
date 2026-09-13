import { afterEach, expect, it } from "vitest";
import { assemblePersonalContext } from "../../src/context-assembler.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { citationAuthorityForContext } from "../../src/personal-context-citation-contract.js";
import { recordCandidateTaskSource } from "../../src/memory-candidate-task-source.js";
import { MorningRecommendationSource } from "../../src/morning-recommendation-source.js";
import { produceDailyRecommendation } from "../../src/personal-context-production.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import {
  admitLocalChainObservation, approveLocalChainOwnerDecisions, persistLocalChainLiveObservation,
  LOCAL_CHAIN_AT,
} from "../fixtures/local-observation-chain.js";
import { priorityPolicyConfig } from "../fixtures/priority-engine-input.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

const TASK = "task:derived-memory";
const NOW = new Date(MEMORY_NOW);
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

/** A derived memory that really came from a task, carried into a context the way a reader would. */
async function derivedMemoryContext() {
  const database = await memoryDatabase();
  open.push(database);
  const authority = database.authority;
  const store = new MemoryCandidateStore(authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(`${database.root}/review`);
  const candidate = store.classify(inferredMemoryInput({ sensitivity: "personal" }));
  recordCandidateTaskSource(authority, candidate.candidate_id, TASK, NOW);
  const contentDigest = String(authority.db
    .prepare("SELECT content_digest FROM memory_candidates WHERE candidate_id=?")
    .pluck().get(candidate.candidate_id));

  await admitLocalChainObservation(authority, LOCAL_CHAIN_AT);
  const live = persistLocalChainLiveObservation(authority, 0, LOCAL_CHAIN_AT);
  const owner = approveLocalChainOwnerDecisions(authority, 0, LOCAL_CHAIN_AT);
  const memory = {
    kind: "evidence" as const, memory_ref: "memory:principle:derived", source_id: "src:pos:v1:second-brain:primary",
    digest: contentDigest, observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:05:00.000Z",
    excerpt: "Derived from the work on that task.", trust: "user_confirmed" as const,
    sensitivity: "personal" as const, relevance: "related" as const, relation: "supports" as const,
  };
  const context = assemblePersonalContext({ purpose: "daily_prioritization", query: "what now?",
    clock: LOCAL_CHAIN_AT, expires_in_ms: 240_000,
    budgets: { max_items: 16, max_excerpt_bytes: 256, max_total_bytes: 4096 },
    observations: [live.observation], pending_authority_refs: [], memories: [memory] });
  const evidence = context.evidence.find(item => item.kind === "confirmed_memory");
  if (evidence === undefined) throw new TypeError("confirmed memory evidence required");
  authority.persistContextSnapshot({ context, memory_evidence: [{ memory_ref: memory.memory_ref,
    evidence_id: evidence.evidence_id, source_id: memory.source_id, digest: memory.digest,
    observed_at: memory.observed_at, fresh_until: memory.fresh_until }] }, LOCAL_CHAIN_AT);
  return { authority, context, memory, live, owner };
}

// Hiding the task already closes the candidate's review, approval and write. A copy derived from
// that task and already carried into a context is the part that was still readable: the consumption
// boundary now asks the same question of it, so the memory stops being something to cite.
it("stops citing a derived memory once the owner hides the task it came from", async () => {
  const { authority, context, memory } = await derivedMemoryContext();

  const before = citationAuthorityForContext(authority, context.id);
  expect(before.citable.map(item => item.reference)).toContain(memory.memory_ref);
  expect(before.uncitable.map(item => item.reason)).not.toContain("closed_task_source");

  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

  const after = citationAuthorityForContext(authority, context.id);
  expect(after.citable.map(item => item.reference)).not.toContain(memory.memory_ref);
  expect(after.uncitable).toContainEqual(expect.objectContaining({
    reference: memory.memory_ref, reason: "closed_task_source" }));
  // The live fact beside it is untouched: closure is asked of the memory's own source, not of the context.
  expect(after.citable.map(item => item.citation_kind)).toEqual(["linux_live_fact"]);
}, 60_000);

// The lineage is immutable, so a recommendation already built on that memory is not rewritten. What
// changes is what the reader offers: it stops being current work and says why.
it("stops offering a recommendation whose derived memory came from a task the owner hid", async () => {
  const { authority, live, owner, memory } = await derivedMemoryContext();
  const produced = produceDailyRecommendation(authority, {
    assemble: { purpose: "daily_prioritization", query: "what now?", clock: LOCAL_CHAIN_AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 256, max_total_bytes: 4096 },
      observations: [live.observation], pending_authority_refs: [], memories: [memory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: memory.memory_ref, owner_import_decision_ref: owner.importDecision.request_id,
    candidates: [{ action_id: "derived-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: owner.ownerGate.request_id,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: memory.memory_ref,
      current_evidence_ref: live.id, stable_identity: { key: "derived-followup", evidence_ref: live.id } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7b01",
      idempotency_key: `idem:pos:v1:recommendation:${"b".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "derived-followup", title: "Next: derived-followup", operation: "review",
        target_digest: `sha256:${"a".repeat(64)}` }] },
  });
  expect(produced.state).toBe("recommended");
  expect(projectRecommendations(authority, LOCAL_CHAIN_AT).next_actions).toHaveLength(1);

  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

  const projection = projectRecommendations(authority, LOCAL_CHAIN_AT);
  expect(projection.next_actions).toEqual([]);
  // The record itself is untouched; only the offer is withdrawn, and the warning names the reason.
  expect(projection.lifecycle_actions).toHaveLength(1);
  expect(projection.warnings.map(item => item.code)).toContain("RECOMMENDATION_MEMORY_SOURCE_CLOSED");
  expect(new MorningRecommendationSource(authority).generate(LOCAL_CHAIN_AT).source.excluded.source_unavailable).toBe(1);
}, 60_000);
