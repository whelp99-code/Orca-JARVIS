import type { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation, prepareLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { Recommendations, rankPriorityActionsWithDeadlineEvidence } from "../../src/index.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1 } from "../../src/personal-validation.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { priorityPolicyConfig } from "./priority-engine-input.js";

export const LOCAL_CHAIN_AT = "2026-08-28T12:00:00.000Z";
export const LOCAL_CHAIN_TASK_ID = "task:fixture";
export const LOCAL_CHAIN_CONTEXT_ID = "ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7100";
export const LOCAL_CHAIN_RECOMMENDATION_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7101";
export const LOCAL_CHAIN_PRINCIPLE_REF = "memory:principle:customer-first";
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
    contextFresh: shift(239_999), contextExpires: shift(240_000), recommendationExpires: shift(180_000) };
}

const OWNER_REF = "decision:owner:import";
const OWNER_GATE_REF = "request:owner:deploy";
const POLICY_REF = "policy:linux:personal-os-policy-v1:task17";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

export const localChainConfirmedMemory = {
  kind: "evidence" as const, memory_ref: LOCAL_CHAIN_PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
  digest: DIGEST_A, observed_at: localChainTimes().observed, fresh_until: localChainTimes().memoryFresh,
  excerpt: "Prioritize confirmed customer obligations before internal improvements.",
  trust: "user_confirmed" as const, sensitivity: "personal" as const,
  relevance: "related" as const, relation: "supports" as const,
};

const MEMORIES = [
  { memory_ref: LOCAL_CHAIN_PRINCIPLE_REF, kind: "user_confirmed_principle", digest: DIGEST_A },
  { memory_ref: OWNER_REF, kind: "owner_decision", digest: DIGEST_B },
  { memory_ref: OWNER_GATE_REF, kind: "owner_decision", digest: DIGEST_C },
] as const;

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
  await db.migrate();
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

/** Cited context: the admitted local observation plus confirmed memory and both owner decisions. */
export function persistLocalChainContext(db: AuthorityDb, observationId: string, observationDigest: string,
  observedAt: string, cycle = 0, base = LOCAL_CHAIN_AT) {
  const identity = localChainIds(cycle);
  const times = localChainTimes(base);
  const evidence = [
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7201", digest: observationDigest,
      kind: "linux_live_fact", source_id: "src:pos:v1:task-timeline:local", observed_at: observedAt },
    ...MEMORIES.map((item, index) => ({ evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f730${index + 1}`,
      digest: item.digest, kind: item.kind, source_id: "src:pos:v1:second-brain:primary",
      observed_at: times.observed })),
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
      included_observation_refs: [observationId], included_memory_refs: MEMORIES.map(item => item.memory_ref),
      excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [],
      budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence, receipt: null,
  });
  const stored = db.persistContextSnapshot({ context, memory_evidence: MEMORIES.map((item, index) => ({
    memory_ref: item.memory_ref, evidence_id: evidence[index + 1]?.evidence_id ?? "",
    source_id: "src:pos:v1:second-brain:primary", digest: item.digest,
    observed_at: times.observed, fresh_until: times.memoryFresh })) }, base);
  return { context, stored, evidence };
}

/** One owner-gated advisory action whose current evidence is the admitted local observation. */
export function createLocalChainRecommendation(db: AuthorityDb, observationId: string, observationDigest: string,
  context: ReturnType<typeof parseContextSnapshotV1>, evidence: readonly { evidence_id: string }[], cycle = 0,
  base = LOCAL_CHAIN_AT) {
  const identity = localChainIds(cycle);
  const times = localChainTimes(base);
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), {
    schema_version: 1, clock: base, linux_policy_decision_ref: POLICY_REF,
    context_policy_input: { schema_version: 1, clock: base,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: [policyFact(observationId, "linux_live_fact", base),
        policyFact(LOCAL_CHAIN_PRINCIPLE_REF, "user_confirmed_principle", base),
        policyFact(OWNER_REF, "owner_decision", base), policyFact(OWNER_GATE_REF, "owner_decision", base)] },
    principles: [{ kind: "evidence", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      evidence_ref: LOCAL_CHAIN_PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
      source_host: "linux-second-brain", content_digest: DIGEST_A, trust: "user_confirmed",
      observed_at: times.observed, fresh_until: times.memoryFresh,
      import_gate: { gate_id: "SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL", state: "approved",
        decision_ref: OWNER_REF, decision_host: "linux-control-plane" } }],
    candidates: [{ action_id: "local-task-followup", execution_mode: "jarvis",
      owner_safety_gate: "owner_approval_required", owner_gate_ref: OWNER_GATE_REF,
      customer_impact: "customer_critical", deadline: null,
      dependency: { kind: "non_blocking" }, irreversible_risk: "low", effort_cost: "medium",
      principle_ref: LOCAL_CHAIN_PRINCIPLE_REF, current_evidence_ref: observationId,
      stable_identity: { key: "local-task-followup", evidence_ref: observationId } }],
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
      target_digest: DIGEST_A }],
    linux_evidence: [
      { ref: LOCAL_CHAIN_PRINCIPLE_REF, kind: "principle", context_evidence_id: evidence[1]?.evidence_id ?? "",
        digest: DIGEST_A },
      { ref: POLICY_REF, kind: "policy", context_evidence_id: null, digest: contextDigest },
      { ref: OWNER_REF, kind: "owner", context_evidence_id: evidence[2]?.evidence_id ?? "", digest: DIGEST_B },
      { ref: observationId, kind: "stable_identity", context_evidence_id: evidence[0]?.evidence_id ?? "",
        digest: observationDigest },
      { ref: OWNER_GATE_REF, kind: "owner", context_evidence_id: evidence[3]?.evidence_id ?? "", digest: DIGEST_C },
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
  const { context, stored, evidence } = persistLocalChainContext(db, observation.id, admitted.canonical_digest,
    observation.observed_at, cycle, base);
  // Publication requires memory lineage on the context; recommendations inherit it at creation.
  new MemoryProjectionAuthority(db).bind({ kind: "context", id: identity.contextId,
    component_id: identity.contextId }, [{ target_digest: LOCAL_CHAIN_MEMORY_TARGET }], new Date(base));
  const created = createLocalChainRecommendation(db, observation.id, admitted.canonical_digest, context,
    evidence, cycle, base);
  return { admitted, observation, context, stored, evidence, created };
}
