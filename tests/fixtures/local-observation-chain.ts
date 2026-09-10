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
const OWNER_REF = "decision:owner:import";
const OWNER_GATE_REF = "request:owner:deploy";
const POLICY_REF = "policy:linux:personal-os-policy-v1:task17";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

export const localChainConfirmedMemory = {
  kind: "evidence" as const, memory_ref: LOCAL_CHAIN_PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
  digest: DIGEST_A, observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
  excerpt: "Prioritize confirmed customer obligations before internal improvements.",
  trust: "user_confirmed" as const, sensitivity: "personal" as const,
  relevance: "related" as const, relation: "supports" as const,
};

const MEMORIES = [
  { memory_ref: LOCAL_CHAIN_PRINCIPLE_REF, kind: "user_confirmed_principle", digest: DIGEST_A },
  { memory_ref: OWNER_REF, kind: "owner_decision", digest: DIGEST_B },
  { memory_ref: OWNER_GATE_REF, kind: "owner_decision", digest: DIGEST_C },
] as const;

function policyFact(ref: string, evidenceClass: string): Record<string, unknown> {
  return { kind: "evidence", ref, evidence_class: evidenceClass,
    source_host: evidenceClass === "user_confirmed_principle" ? "linux-second-brain" : "linux-control-plane",
    state: "current", trust: "user_confirmed", relation: "supports",
    relates_to: evidenceClass === "linux_live_fact" ? null : LOCAL_CHAIN_PRINCIPLE_REF,
    observed_at: "2026-08-28T11:30:00.000Z", valid_from: "2026-08-28T11:00:00.000Z",
    valid_until: "2026-08-28T18:00:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z" };
}

/** Migrates, seeds one synthetic task and admits its exact current local observation. */
export async function admitLocalChainObservation(db: AuthorityDb) {
  const clock = () => new Date(LOCAL_CHAIN_AT);
  await db.migrate();
  db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
    VALUES ('fixture','${LOCAL_CHAIN_TASK_ID}','dispatch','{}','sha256:fixture','fixture','pending','2026-08-28T11:00:00.000Z')`);
  const store = new LocalTimelineSnapshotStore(db, clock);
  store.register(LOCAL_CHAIN_TASK_ID);
  const snapshot = store.refresh(LOCAL_CHAIN_TASK_ID);
  const admitted = admitLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  const observation = prepareLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  return { store, admitted, observation };
}

/** Cited context: the admitted local observation plus confirmed memory and both owner decisions. */
export function persistLocalChainContext(db: AuthorityDb, observationId: string, observationDigest: string,
  observedAt: string, cycle = 0) {
  const identity = localChainIds(cycle);
  const evidence = [
    { evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7201", digest: observationDigest,
      kind: "linux_live_fact", source_id: "src:pos:v1:task-timeline:local", observed_at: observedAt },
    ...MEMORIES.map((item, index) => ({ evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f730${index + 1}`,
      digest: item.digest, kind: item.kind, source_id: "src:pos:v1:second-brain:primary",
      observed_at: "2026-08-28T11:30:00.000Z" })),
  ];
  const context = parseContextSnapshotV1({
    schema_version: 1, id: identity.contextId, created_at: LOCAL_CHAIN_AT, observed_at: LOCAL_CHAIN_AT,
    valid_at: LOCAL_CHAIN_AT,
    source: { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority",
      host_id: "host:pos:linux-control-plane", source_version: "local-lineage-v1",
      evidence_ref: "context:local-lineage" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: LOCAL_CHAIN_AT, fresh_until: "2026-08-28T12:03:59.999Z" },
    expires_at: "2026-08-28T12:04:00.000Z", idempotency_key: `idem:pos:v1:context:${identity.contextKey}`,
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
    observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z" })) }, LOCAL_CHAIN_AT);
  return { context, stored, evidence };
}

/** One owner-gated advisory action whose current evidence is the admitted local observation. */
export function createLocalChainRecommendation(db: AuthorityDb, observationId: string, observationDigest: string,
  context: ReturnType<typeof parseContextSnapshotV1>, evidence: readonly { evidence_id: string }[], cycle = 0) {
  const identity = localChainIds(cycle);
  const ranking = rankPriorityActionsWithDeadlineEvidence(priorityPolicyConfig(), {
    schema_version: 1, clock: LOCAL_CHAIN_AT, linux_policy_decision_ref: POLICY_REF,
    context_policy_input: { schema_version: 1, clock: LOCAL_CHAIN_AT,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: [policyFact(observationId, "linux_live_fact"),
        policyFact(LOCAL_CHAIN_PRINCIPLE_REF, "user_confirmed_principle"),
        policyFact(OWNER_REF, "owner_decision"), policyFact(OWNER_GATE_REF, "owner_decision")] },
    principles: [{ kind: "evidence", principle_ref: LOCAL_CHAIN_PRINCIPLE_REF,
      evidence_ref: LOCAL_CHAIN_PRINCIPLE_REF, source_id: "src:pos:v1:second-brain:primary",
      source_host: "linux-second-brain", content_digest: DIGEST_A, trust: "user_confirmed",
      observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
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
    context_id: identity.contextId, context_digest: contextDigest, expires_at: "2026-08-28T12:03:00.000Z",
    ranking,
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
export async function localObservationChain(db: AuthorityDb) {
  const { store, admitted, observation } = await admitLocalChainObservation(db);
  return { store, ...buildLocalChainCycle(db, admitted, observation, 0) };
}

/**
 * Another producer cycle over the same unchanged task: a replacement collection, its own admitted
 * observation, and its own cited context and recommendation.
 */
export function extendLocalObservationChain(db: AuthorityDb, store: LocalTimelineSnapshotStore, cycle: number) {
  const clock = () => new Date(LOCAL_CHAIN_AT);
  const snapshot = store.refresh(LOCAL_CHAIN_TASK_ID);
  const admitted = admitLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  const observation = prepareLocalTimelineObservation(db, LOCAL_CHAIN_TASK_ID, snapshot.collection_id, clock);
  return buildLocalChainCycle(db, admitted, observation, cycle);
}

function buildLocalChainCycle(db: AuthorityDb, admitted: { canonical_digest: string },
  observation: ReturnType<typeof prepareLocalTimelineObservation>, cycle: number) {
  const identity = localChainIds(cycle);
  const { context, stored, evidence } = persistLocalChainContext(db, observation.id, admitted.canonical_digest,
    observation.observed_at, cycle);
  // Publication requires memory lineage on the context; recommendations inherit it at creation.
  new MemoryProjectionAuthority(db).bind({ kind: "context", id: identity.contextId,
    component_id: identity.contextId }, [{ target_digest: LOCAL_CHAIN_MEMORY_TARGET }],
  new Date(LOCAL_CHAIN_AT));
  const created = createLocalChainRecommendation(db, observation.id, admitted.canonical_digest, context,
    evidence, cycle);
  return { admitted, observation, context, stored, evidence, created };
}
