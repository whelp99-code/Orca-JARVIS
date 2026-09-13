import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { ControlPlane } from "../../src/control-plane.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { memoryProjectScopePath } from "../../src/memory-candidate-project-scope.js";
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
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { MemoryReferenceProvider, REFERENCE_NOW } from "../fixtures/memory-reference-provider.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { decideFixtureOwnerCommand } from "../fixtures/fixture-authority.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
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
  // The owner confirms this derived memory through the staging the dashboard uses. Without that
  // nothing may rest on it at all, and the closure this test is about would never be reached.
  const mutation = new MemoryMutationService({ authority, clock: () => NOW,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => NOW),
    candidate_review_spool_root: `${database.root}/review`,
    candidate_dispatch_spool_root: `${database.root}/dispatch` });
  const confirmation = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"3".repeat(64)}` });
  if (confirmation === undefined) throw new TypeError("confirmation command required");
  decideFixtureOwnerCommand(authority, confirmation, MEMORY_NOW);
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

// A read that began before the owner hid the task returns afterwards carrying the identity it read.
// The question is whether the consumption boundary asks again once the response is in hand, so the
// provider call is held open and the hide lands strictly between the call starting and its return -
// the ordering comes from the promise the test resolves, not from a timer.
//
// The provider supplies the real in-flight boundary. The derived memory's identity is the
// candidate's own content digest: translating a provider record into context memory evidence has no
// production path yet, which is recorded as an open item rather than pretended here.
it("keeps a read that began before the task was hidden from putting that memory back into current work", async () => {
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

  const provider = new MemoryReferenceProvider();
  const { config } = memoryReadFenceFixture(database);
  const runtime = createProductionMemoryReference(authority, { transport: provider,
    read_fence_config: config, projection_key: Buffer.alloc(32, 7), clock: () => REFERENCE_NOW });
  let release: () => void = () => {};
  let began: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  provider.onCall = async () => { began(); await held; };
  const reading = runtime.reader.read("기억", { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 });
  await started;

  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);
  release();
  await reading;

  const memory = {
    kind: "evidence" as const, memory_ref: "memory:principle:derived",
    source_id: "src:pos:v1:second-brain:primary", digest: contentDigest,
    observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:05:00.000Z",
    excerpt: "Derived from the work on that task.", trust: "user_confirmed" as const,
    sensitivity: "personal" as const, relevance: "related" as const, relation: "supports" as const,
  };
  const produced = produceDailyRecommendation(authority, {
    assemble: { purpose: "daily_prioritization", query: "what now?", clock: LOCAL_CHAIN_AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 256, max_total_bytes: 4096 },
      observations: [live.observation], pending_authority_refs: [], memories: [memory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: memory.memory_ref, owner_import_decision_ref: owner.importDecision.request_id,
    candidates: [{ action_id: "late-read-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: owner.ownerGate.request_id,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: memory.memory_ref,
      current_evidence_ref: live.id, stable_identity: { key: "late-read-followup", evidence_ref: live.id } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7c01",
      idempotency_key: `idem:pos:v1:recommendation:${"c".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "late-read-followup", title: "Next: late-read-followup", operation: "review",
        target_digest: `sha256:${"a".repeat(64)}` }] },
  });

  expect(produced.state).toBe("abstained");
  expect(Number(authority.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
  const carried = citationAuthorityForContext(authority, produced.context.id);
  expect(carried.uncitable).toContainEqual(expect.objectContaining({
    reference: memory.memory_ref, reason: "closed_task_source" }));
  expect(projectRecommendations(authority, LOCAL_CHAIN_AT).next_actions).toEqual([]);
  expect(new MorningRecommendationSource(authority).generate(LOCAL_CHAIN_AT).brief.abstention_reasons)
    .toEqual(["no_data"]);
}, 60_000);

const hideTask = (authority: AuthorityDb): void =>
  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id: TASK, component_id: TASK }, NOW);

// The closure is recorded, not remembered, so another connection onto the same database - which is
// all a restart leaves behind - reaches the same answer without being told.
it("still refuses the memory through a connection opened after the closure", async () => {
  const { authority, context, memory } = await derivedMemoryContext();
  hideTask(authority);
  const reopened = new AuthorityDb(authority.filename);
  try {
    expect(citationAuthorityForContext(reopened, context.id).uncitable)
      .toContainEqual(expect.objectContaining({ reference: memory.memory_ref, reason: "closed_task_source" }));
  } finally { reopened.close(); }
}, 60_000);

// Narrowing the project policy closes the same door without anything being hidden: the document is
// the owner's statement, and a task whose project this database cannot prove is not on the list.
it("closes a derived memory when the owner narrows the project policy", async () => {
  const { authority, context, memory } = await derivedMemoryContext();
  expect(citationAuthorityForContext(authority, context.id).citable.map(item => item.reference))
    .toContain(memory.memory_ref);

  writeFileSync(memoryProjectScopePath(authority.filename),
    JSON.stringify({ schema_version: 1, mode: "allow_list", projects: ["project:allowed"] }));

  expect(citationAuthorityForContext(authority, context.id).uncitable)
    .toContainEqual(expect.objectContaining({ reference: memory.memory_ref, reason: "closed_task_source" }));
}, 60_000);

// A rebuilt database carries the binding and the closure with it, so the memory does not re-enter
// on the way back in.
it("keeps the closure through a rebuild of the authority database", async () => {
  const { authority, context, memory } = await derivedMemoryContext();
  hideTask(authority);
  const fresh = join(dirname(authority.filename), "rebuilt-closure.sqlite");
  const result = await buildFreshAuthority(authority, fresh, { blocked_projections: [], sensitive_material: [] });
  expect(result.integrity_check).toBe("ok");
  const rebuilt = new AuthorityDb(fresh);
  try {
    expect(citationAuthorityForContext(rebuilt, context.id).uncitable)
      .toContainEqual(expect.objectContaining({ reference: memory.memory_ref, reason: "closed_task_source" }));
  } finally { rebuilt.close(); }
}, 60_000);

// Revoking the owner's approval is the control plane's own act, and the production path reads the
// receipt rather than a memory of one, so the next run has no owner decision to rest on.
it("builds no new work on an owner approval the owner revoked", async () => {
  const { authority, live, owner, memory } = await derivedMemoryContext();
  new ControlPlane(authority).cancel({ request_id: owner.importDecision.request_id,
    reason: "owner withdrew the import decision", revoked_by: "principal:owner",
    revoked_at: LOCAL_CHAIN_AT }, new Date(LOCAL_CHAIN_AT));

  const produced = produceDailyRecommendation(authority, {
    assemble: { purpose: "daily_prioritization", query: "what now?", clock: LOCAL_CHAIN_AT,
      expires_in_ms: 240_000, budgets: { max_items: 16, max_excerpt_bytes: 256, max_total_bytes: 4096 },
      observations: [live.observation], pending_authority_refs: [], memories: [memory] } as never,
    policy: priorityPolicyConfig(), policy_decision_ref: "policy:linux:personal-os-policy-v1:task17",
    principle_ref: memory.memory_ref, owner_import_decision_ref: owner.importDecision.request_id,
    candidates: [{ action_id: "revoked-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: owner.ownerGate.request_id,
      customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: memory.memory_ref,
      current_evidence_ref: live.id, stable_identity: { key: "revoked-followup", evidence_ref: live.id } }],
    recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7d01",
      idempotency_key: `idem:pos:v1:recommendation:${"d".repeat(64)}`,
      correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
      expires_at: "2026-08-28T12:03:00.000Z", confidence_class: "high",
      actions: [{ action_id: "revoked-followup", title: "Next: revoked-followup", operation: "review",
        target_digest: `sha256:${"a".repeat(64)}` }] },
  });

  expect(produced.state).toBe("abstained");
  expect(Number(authority.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get())).toBe(0);
}, 60_000);
