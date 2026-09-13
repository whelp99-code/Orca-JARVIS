import type { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation, prepareLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { Recommendations, normalizePersonalObservations,
  rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import type { OrcaTaskObservationInput } from "../../src/index.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "../../src/personal-validation.js";
import { approveFixtureOwnerDecision, decideFixtureOwnerCommand, sealFixtureAuthority,
  type FixtureOwnerApproval } from "./fixture-authority.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { memoryCandidateSpoolRoots } from "../../src/memory-outbox-production.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { evidenceRef, inferredMemoryInput, memoryPolicy } from "./memory-candidate-fixture.js";
import { ownerConfirmedContent } from "../../src/personal-memory-reference-evidence.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { priorityPolicyConfig } from "./priority-engine-input.js";

export const LOCAL_CHAIN_AT = "2026-08-28T12:00:00.000Z";
export const LOCAL_CHAIN_TASK_ID = "task:fixture";
export const LOCAL_CHAIN_CONTEXT_ID = "ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7100";
export const LOCAL_CHAIN_RECOMMENDATION_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7101";
export const LOCAL_CHAIN_PRINCIPLE_REF = "memory:principle:customer-first";
/** The subject a live observation of this chain's task reports, which is what its gate authorizes. */
export const LOCAL_CHAIN_SUBJECT = `task:${LOCAL_CHAIN_TASK_ID}`;
export const LOCAL_CHAIN_MEMORY_TARGET = `sha256:${"d".repeat(64)}`;

/** Distinct identities per producer cycle; cycle 0 keeps the original constants. */
export function localChainIds(cycle = 0) {
  const suffix = String(cycle).padStart(2, "0");
  return cycle === 0
    ? { contextId: LOCAL_CHAIN_CONTEXT_ID, recommendationId: LOCAL_CHAIN_RECOMMENDATION_ID,
      contextKey: "1".repeat(64), recommendationKey: "c".repeat(64) }
    : { contextId: `ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f72${suffix}`,
      recommendationId: `rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f73${suffix}`,
      contextKey: `${suffix}`.repeat(32), recommendationKey: `${suffix}`.repeat(32) };
}

/**
 * Every instant in this chain derives from one base, so a caller can place a whole chain at a
 * different time. Offsets, not literals, are what keep the ordering rules satisfied: the context
 * outlives the recommendation, both expire before the memory, and the source predates all of them.
 */
export function localChainTimes(base = LOCAL_CHAIN_AT) {
  const shift = (ms: number): string => new Date(Date.parse(base) + ms).toISOString();
  return { base, sourceCreated: shift(-3_600_000), observed: shift(-1_800_000),
    validFrom: shift(-3_600_000), validUntil: shift(21_600_000), memoryFresh: shift(1_800_000),
    ownerApprovalExpires: shift(7_200_000), ownerReceiptExpires: shift(600_000),
    contextFresh: shift(239_999), contextExpires: shift(240_000), recommendationExpires: shift(180_000) };
}

const POLICY_REF = "policy:linux:personal-os-policy-v1:task17";
const PRINCIPLE_STATEMENT = "Prioritize confirmed customer obligations before internal improvements.";
const PRINCIPLE_IDEMPOTENCY_KEY = "candidate:local-chain:principle";

/**
 * The owner's confirmation of this chain's one principle, taken through the product's own path.
 *
 * A caller can write `trust: "user_confirmed"` beside a memory and the assembler will seal it as a
 * confirmed principle, because assembly has nothing else to go on. The licence to cite it does not
 * come from there: it comes from a candidate this database classified and a receipt the owner
 * signed, which is what the citation authority reads. So the chain confirms one for real, and every
 * digest below is the content digest that confirmation is about.
 */
export function confirmLocalChainPrinciple(db: AuthorityDb, base = LOCAL_CHAIN_AT): string {
  const at = new Date(base);
  const roots = memoryCandidateSpoolRoots(db.filename);
  // A chain is built in cycles, each at its own instant, and a database can be copied or reopened
  // between them. The candidate this principle rests on is therefore looked up before anything is
  // classified again: proposing the same memory a second time under one idempotency key is a replay
  // conflict, and the owner already answered the first proposal.
  const recorded = db.db.prepare(
    "SELECT candidate_id,content_digest,state FROM memory_candidates WHERE idempotency_key=? ORDER BY rowid LIMIT 1")
    .get(PRINCIPLE_IDEMPOTENCY_KEY) as
    { candidate_id: string; content_digest: string; state: string } | undefined;
  const candidate = recorded ?? (() => {
    const store = new MemoryCandidateStore(db, memoryPolicy(), () => at);
    store.attachReviewSpool(roots.candidate_review_spool_root);
    const classified = store.classify(inferredMemoryInput({
      subject: "wiki/customer-first", statement: PRINCIPLE_STATEMENT,
      idempotency_key: PRINCIPLE_IDEMPOTENCY_KEY,
      // The inference this principle rests on has to be current whenever the chain is built, and
      // the candidate has to be the same candidate every time: an identity that moved with the
      // chain's clock would be a second proposal of one memory under one idempotency key.
      source: { class: "labeled_inference", source_id: "inference-source-local-chain",
        source_version: "v1", inference_id: "inference-local-chain", label: "inference",
        references: [evidenceRef("inference_evidence", "local-chain",
          { observed_at: "2026-08-28T00:00:00.000Z", fresh_until: "2126-08-28T00:00:00.000Z",
            expires_at: "2126-08-29T00:00:00.000Z" })] } }));
    return { candidate_id: classified.candidate_id, content_digest: String(classified.content_digest),
      state: String(db.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
        .pluck().get(classified.candidate_id)) };
  })();
  const digest = String(candidate.content_digest);
  if (ownerConfirmedContent(db, digest)) return digest;
  if (candidate.state !== "awaiting_confirmation") {
    throw new TypeError(`local chain principle is ${candidate.state} without an owner confirmation`);
  }
  const mutation = new MemoryMutationService({ authority: db, clock: () => at,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => at),
    candidate_review_spool_root: roots.candidate_review_spool_root,
    candidate_dispatch_spool_root: roots.candidate_dispatch_spool_root });
  const command = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: "confirm", intent_id: `memui:intent:v1:${"2".repeat(64)}` });
  if (command === undefined) throw new TypeError("confirmation command required");
  decideFixtureOwnerCommand(db, command, base);
  return digest;
}

/**
 * The same principle as a caller would simply declare it: the word "user_confirmed" beside a digest
 * this database knows nothing about. The assembler classifies what it is given, so this is the
 * right input for testing that classification - and the wrong thing to rest a stored citation on.
 */
export const localChainDeclaredMemory = {
  kind: "evidence" as const, memory_ref: LOCAL_CHAIN_PRINCIPLE_REF,
  source_id: "src:pos:v1:second-brain:primary", digest: `sha256:${"a".repeat(64)}`,
  observed_at: localChainTimes().observed, fresh_until: localChainTimes().memoryFresh,
  excerpt: PRINCIPLE_STATEMENT, trust: "user_confirmed" as const, sensitivity: "personal" as const,
  relevance: "related" as const, relation: "supports" as const,
};

/** The principle as an assembler input, carrying the digest the owner really confirmed. */
export function localChainConfirmedMemory(db: AuthorityDb, base = LOCAL_CHAIN_AT) {
  return {
    kind: "evidence" as const, memory_ref: LOCAL_CHAIN_PRINCIPLE_REF,
    source_id: "src:pos:v1:second-brain:primary", digest: confirmLocalChainPrinciple(db, base),
    observed_at: localChainTimes(base).observed, fresh_until: localChainTimes(base).memoryFresh,
    excerpt: PRINCIPLE_STATEMENT, trust: "user_confirmed" as const, sensitivity: "personal" as const,
    relevance: "related" as const, relation: "supports" as const,
  };
}

/**
 * The one memory this chain carries, sealed under the kind the real assembler writes for a
 * user-confirmed principle. Owner decisions are deliberately absent: an owner decision is an
 * authority receipt held by the control plane, and writing one into a context as memory evidence
 * would be inventing the authority rather than citing it.
 */
function principleMemory(db: AuthorityDb, base: string) {
  return { memory_ref: LOCAL_CHAIN_PRINCIPLE_REF, kind: "confirmed_memory",
    digest: confirmLocalChainPrinciple(db, base) } as const;
}

/** One shared authority bootstrap, so the two fixture families cannot drift apart. */
export const sealLocalChainAuthority = sealFixtureAuthority;

/**
 * A verified live Linux observation of the same task: the one piece of this chain an action may
 * cite as a current fact. The local timeline observation beside it reports what a local cache said
 * and stays advisory, which is why it is included in the context but never cited.
 */
function localChainLiveTask(cycle: number, base: string): OrcaTaskObservationInput {
  const times = localChainTimes(base);
  const suffix = String(cycle).padStart(2, "0");
  // One source's checkpoints must advance: a later observation of the same source has to carry a
  // later observed_at, so each producer cycle reports the task a second further on.
  const observedAt = new Date(Date.parse(times.observed) + cycle * 1_000).toISOString();
  return {
    environment: "local", worktree: "/home/jm/orca/workspaces/local-chain",
    worktree_id: "worktree-local-chain", terminal_id: "terminal-local-chain",
    session_id: "session-local-chain", incarnation_id: `incarnation-local-chain-${suffix}`,
    pty_id: "pty-local-chain", cursor: `cursor-local-chain-${suffix}`, working: true,
    timeline: { schema_version: 1, generated_at: base,
      task: { task_id: LOCAL_CHAIN_TASK_ID, title: "not persisted", kind: "work", state: "running",
        updated_at: observedAt, pending_approval: false, source_ids: ["source-local-chain"] },
      events: [{ event_id: `evidence-local-chain-${suffix}`, task_id: LOCAL_CHAIN_TASK_ID,
        source: "verification", kind: "evidence", actor: "verifier", title: "not persisted",
        status: "recorded", payload: { fact: "not persisted" },
        evidence_refs: [`verify-local-chain-${suffix}`], created_at: observedAt, sequence: 1 }],
      pending_decisions: [], workers: [], evidence: [], truncated: false },
  };
}

/**
 * The instant at which a whole chain has aged out. A chain cites two observations with different
 * lifetimes, and a cutoff reaching only the local collection leaves the live fact beside it still
 * current - which the selector correctly refuses to remove around.
 */
export function localChainCutoff(db: AuthorityDb): string {
  return String(db.db.prepare("SELECT MAX(expires_at) FROM personal_observations").pluck().get());
}

/** Normalizes and persists that live observation through the real producer path. */
export function persistLocalChainLiveObservation(db: AuthorityDb, cycle = 0, base = LOCAL_CHAIN_AT) {
  const observations = normalizePersonalObservations({ checked_at: base,
    orca_tasks: [localChainLiveTask(cycle, base)], portfolios: [] });
  const observation = observations[0];
  if (observation === undefined) throw new TypeError("live observation required");
  const stored = db.persistObservation(observation, base);
  return { id: observation.id, digest: stored.canonical_digest,
    source_id: observation.source.source_id, observed_at: observation.observed_at, observation };
}

export type LocalChainOwnerApprovals = { readonly importDecision: FixtureOwnerApproval;
  readonly ownerGate: FixtureOwnerApproval };

/**
 * Two real owner approvals in the control plane: the decision that admitted the imported principle
 * and the gate the owner-gated action rests on. Each is staged and then decided with a receipt
 * signed by the trusted decision key, so the consumption boundary has something to verify.
 */
export function approveLocalChainOwnerDecisions(db: AuthorityDb, cycle = 0,
  base = LOCAL_CHAIN_AT): LocalChainOwnerApprovals {
  const suffix = String(cycle).padStart(2, "0");
  return {
    importDecision: approveFixtureOwnerDecision(db, `req:local-chain:import:${suffix}`, base),
    ownerGate: approveFixtureOwnerDecision(db, `req:local-chain:gate:${suffix}`, base, LOCAL_CHAIN_SUBJECT),
  };
}

function policyFact(ref: string, evidenceClass: string, base: string): Record<string, unknown> {
  const times = localChainTimes(base);
  return { kind: "evidence", ref, evidence_class: evidenceClass,
    source_host: evidenceClass === "user_confirmed_principle" ? "linux-second-brain" : "linux-control-plane",
    state: "current", trust: "user_confirmed", relation: "supports",
    relates_to: evidenceClass === "linux_live_fact" ? null : LOCAL_CHAIN_PRINCIPLE_REF,
    observed_at: times.observed, valid_from: times.validFrom,
    valid_until: times.validUntil, fresh_until: times.memoryFresh };
}

/** Migrates, seeds one synthetic task and admits its exact current local observation. */
export async function admitLocalChainObservation(db: AuthorityDb, base = LOCAL_CHAIN_AT) {
  const times = localChainTimes(base);
  const clock = () => new Date(base);
  await sealLocalChainAuthority(db);
  db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
    idempotency_key,state,created_at) VALUES('fixture',?,'dispatch','{}','sha256:fixture','fixture','pending',?)`)
    .run(LOCAL_CHAIN_TASK_ID, times.sourceCreated);
  const store = new LocalTimelineSnapshotStore(db, clock);
  store.register(LOCAL_CHAIN_TASK_ID);
  const snapshot = store.refresh(LOCAL_CHAIN_TASK_ID);
  const admitted = admitLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  const observation = prepareLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  return { store, admitted, observation };
}

export type LocalChainObservationRef = { readonly id: string; readonly digest: string;
  readonly source_id: string; readonly observed_at: string };

/**
 * Cited context: the advisory local observation, the verified live observation beside it, and the
 * confirmed principle - each sealed under the kind the real assembler writes for it, so nothing
 * here claims an authority its source cannot show.
 */
export function persistLocalChainContext(db: AuthorityDb, local: LocalChainObservationRef,
  live: LocalChainObservationRef, cycle = 0, base = LOCAL_CHAIN_AT) {
  const identity = localChainIds(cycle);
  const times = localChainTimes(base);
  const principle = principleMemory(db, base);
  const evidence = [
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7201", digest: local.digest,
      kind: "context_observation", source_id: local.source_id, observed_at: local.observed_at },
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7202", digest: live.digest,
      kind: "context_observation", source_id: live.source_id, observed_at: live.observed_at },
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", digest: principle.digest,
      kind: principle.kind, source_id: "src:pos:v1:second-brain:primary",
      observed_at: times.observed },
  ];
  const context = parseContextSnapshotV1({
    schema_version: 1, id: identity.contextId, created_at: base, observed_at: base, valid_at: base,
    source: { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority",
      host_id: "host:pos:linux-control-plane", source_version: "local-lineage-v1",
      evidence_ref: "context:local-lineage" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: base, fresh_until: times.contextFresh },
    expires_at: times.contextExpires, idempotency_key: `idem:pos:v1:context:${identity.contextKey}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    payload: { purpose: "daily_prioritization", query: "What should happen next?",
      included_observation_refs: [local.id, live.id],
      included_memory_refs: [principle.memory_ref],
      excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [],
      budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence, receipt: null,
  });
  const stored = db.persistContextSnapshot({ context, memory_evidence: [{
    memory_ref: principle.memory_ref, evidence_id: evidence[2]?.evidence_id ?? "",
    source_id: "src:pos:v1:second-brain:primary", digest: principle.digest,
    observed_at: times.observed, fresh_until: times.memoryFresh }] }, base);
  return { context, stored, evidence };
}

/** One owner-gated action whose current evidence is the verified live observation. */
export function createLocalChainRecommendation(db: AuthorityDb, live: LocalChainObservationRef,
  owner: LocalChainOwnerApprovals, context: ReturnType<typeof parseContextSnapshotV1>,
  evidence: readonly { evidence_id: string }[], cycle = 0, base = LOCAL_CHAIN_AT) {
  const identity = localChainIds(cycle);
  const times = localChainTimes(base);
  const principleDigest = confirmLocalChainPrinciple(db, base);
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), {
    schema_version: 1, clock: base, linux_policy_decision_ref: POLICY_REF,
    context_policy_input: { schema_version: 1, clock: base,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: [policyFact(live.id, "linux_live_fact", base),
        policyFact(LOCAL_CHAIN_PRINCIPLE_REF, "user_confirmed_principle", base),
        policyFact(owner.importDecision.request_id, "owner_decision", base),
        policyFact(owner.ownerGate.request_id, "owner_decision", base)] },
    principles: [{ kind: "evidence", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      evidence_ref: LOCAL_CHAIN_PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
      source_host: "linux-second-brain", content_digest: principleDigest, trust: "user_confirmed",
      observed_at: times.observed, fresh_until: times.memoryFresh,
      import_gate: { gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL", state: "approved",
        decision_ref: owner.importDecision.request_id, decision_host: "linux-control-plane" } }],
    candidates: [{ action_id: "local-task-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: owner.ownerGate.request_id,
      customer_impact: "customer_critical", deadline: null,
      dependency: { kind: "non_blocking" }, irreversible_risk: "low", effort_cost: "medium",
      principle_ref: LOCAL_CHAIN_PRINCIPLE_REF, current_evidence_ref: live.id,
      stable_identity: { key: "local-task-followup", evidence_ref: live.id } }],
    presentation: { model_disagrees: false, model_preferred_action_ids: [], mac_evidence_refs: [] },
  });
  const contextDigest = canonicalPersonalContractHash(context);
  return new Recommendations(db).create({
    id: identity.recommendationId,
    idempotency_key: `idem:pos:v1:recommendation:${identity.recommendationKey}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    context_id: identity.contextId, context_digest: contextDigest,
    expires_at: times.recommendationExpires, ranking,
    actions: [{ action_id: "local-task-followup", title: "Next: local-task-followup", operation: "review",
      target_digest: principleDigest }],
    linux_evidence: [
      { ref: LOCAL_CHAIN_PRINCIPLE_REF, kind: "principle", context_evidence_id: evidence[2]?.evidence_id ?? "",
        digest: principleDigest },
      { ref: POLICY_REF, kind: "policy", context_evidence_id: null, digest: contextDigest },
      { ref: owner.importDecision.request_id, kind: "owner", context_evidence_id: null,
        digest: owner.importDecision.command_digest },
      { ref: live.id, kind: "stable_identity", context_evidence_id: evidence[1]?.evidence_id ?? "",
        digest: live.digest },
      { ref: owner.ownerGate.request_id, kind: "owner", context_evidence_id: null,
        digest: owner.ownerGate.command_digest },
    ],
    approval_requirement: "owner", confidence_class: "high",
  });
}

/** source -> collection -> admitted observation -> cited context -> recommendation, in one database. */
export async function localObservationChain(db: AuthorityDb, base = LOCAL_CHAIN_AT) {
  const { store, admitted, observation } = await admitLocalChainObservation(db, base);
  return { store, ...buildLocalChainCycle(db, admitted, observation, 0, base) };
}

/**
 * Another producer cycle over the same unchanged task: a replacement collection, its own admitted
 * observation, and its own cited context and recommendation. A later base places the whole cycle
 * further out, which is how two cycles get distinct expiries.
 */
export function extendLocalObservationChain(db: AuthorityDb, cycle: number, base = LOCAL_CHAIN_AT) {
  const clock = () => new Date(base);
  // The collection must be taken on the cycle's own clock, or admission at a later base would
  // read a snapshot that already expired 300s after the earlier one started.
  const store = new LocalTimelineSnapshotStore(db, clock);
  const snapshot = store.refresh(LOCAL_CHAIN_TASK_ID);
  const admitted = admitLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  const observation = prepareLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  return buildLocalChainCycle(db, admitted, observation, cycle, base);
}

function buildLocalChainCycle(db: AuthorityDb, admitted: { canonical_digest: string },
  observation: ReturnType<typeof prepareLocalTimelineObservation>, cycle: number, base: string) {
  const identity = localChainIds(cycle);
  const live = persistLocalChainLiveObservation(db, cycle, base);
  const owner = approveLocalChainOwnerDecisions(db, cycle, base);
  const local = { id: observation.id, digest: admitted.canonical_digest,
    source_id: observation.source.source_id, observed_at: observation.observed_at };
  const { context, stored, evidence } = persistLocalChainContext(db, local, live, cycle, base);
  // Publication requires memory lineage on the context; recommendations inherit it at creation.
  new MemoryProjectionAuthority(db).bind({ kind: "context", id: identity.contextId,
    component_id: identity.contextId }, [{ target_digest: LOCAL_CHAIN_MEMORY_TARGET }], new Date(base));
  const created = createLocalChainRecommendation(db, live, owner, context, evidence, cycle, base);
  return { admitted, observation, live, owner, context, stored, evidence, created };
}
