import { createHash } from "node:crypto";
import {
  canonicalPersonalContractHash,
  parseContextSnapshotV1,
  rankPriorityActions,
  type AuthorityDb,
  type PriorityEngineResult,
  type Sha256Digest,
} from "../../src/index.js";
import { defaultPriorityCandidates } from "./priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "./priority-engine-input.js";

export const RECOMMENDATION_NOW = "2026-08-28T12:00:00.000Z";
export const RECOMMENDATION_EXPIRES = "2026-08-28T13:00:00.000Z";
export const RECOMMENDATION_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7101";
export const REPLACEMENT_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7102";
const CONTEXT_ID = "ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7100";
const CONTEXT_REFERENCE_KINDS = [
  ["memory:principle:customer-first", "user_confirmed_principle"],
  ["second-brain:sid:customer-first", "user_confirmed_principle"],
  ["decision:owner:import", "owner_decision"],
  ["live:customer", "linux_live_fact"],
  ["live:deadline", "linux_live_fact"],
  ["live:dependency", "linux_live_fact"],
  ["identity:customer-delivery", "linux_live_fact"],
  ["live:worker", "linux_live_fact"],
  ["identity:worker-implementation", "linux_live_fact"],
  ["live:owner-gated", "linux_live_fact"],
  ["request:owner:deploy", "owner_decision"],
  ["identity:owner-gated-deploy", "linux_live_fact"],
] as const;
function digest(value: string): Sha256Digest {
  const candidate = `sha256:${createHash("sha256").update(value).digest("hex")}`;
  function valid(item: string): item is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(item); }
  if (!valid(candidate)) throw new TypeError("fixture digest required");
  return candidate;
}
const evidence = CONTEXT_REFERENCE_KINDS.map(([reference, kind], index) => ({
  evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f72${String(index + 1).padStart(2, "0")}`,
  digest: digest(`evidence:${reference}`),
  kind,
  source_id: "src:pos:v1:second-brain:primary",
  observed_at: "2026-08-28T11:59:00.000Z",
}));

export function task18Ranking(): PriorityEngineResult {
  const wanted = new Set(["customer-delivery", "worker-implementation", "owner-gated-deploy"]);
  const candidates = defaultPriorityCandidates().filter(candidate => wanted.has(String(candidate["action_id"])));
  return rankPriorityActions(priorityPolicyConfig(), priorityEngineInput({ candidates }));
}

export function persistTask18Context(db: AuthorityDb, expiresAt = RECOMMENDATION_EXPIRES) {
  const context = parseContextSnapshotV1({
    schema_version: 1, id: CONTEXT_ID, created_at: RECOMMENDATION_NOW,
    observed_at: "2026-08-28T11:59:00.000Z", valid_at: "2026-08-28T11:59:00.000Z",
    source: {
      source_id: "src:pos:v1:jarvis:primary", source_kind: "authority",
      host_id: "host:pos:linux-control-plane", source_version: "task15-v1", evidence_ref: "context:task18",
    },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: RECOMMENDATION_NOW, fresh_until: "2026-08-28T12:59:59.999Z" },
    expires_at: expiresAt, idempotency_key: `idem:pos:v1:context:${"1".repeat(64)}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    payload: { purpose: "daily_prioritization", query: "What should happen next?", included_observation_refs: [],
      included_memory_refs: CONTEXT_REFERENCE_KINDS.map(([reference]) => reference), excluded_refs: [], pending_authority_refs: [],
      conflicts: ["calendar and customer dates differ"], omissions: ["mail unavailable"],
      budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] }, evidence, receipt: null,
  });
  db.persistContextSnapshot({ context, memory_evidence: evidence.map((item, index) => ({
    memory_ref: CONTEXT_REFERENCE_KINDS[index]?.[0] ?? `missing:${index}`,
    evidence_id: item.evidence_id, source_id: item.source_id, digest: item.digest,
    observed_at: item.observed_at, fresh_until: context.expires_at,
  })) }, RECOMMENDATION_NOW);
  return context;
}

export function task18EvidenceForReference(context: ReturnType<typeof parseContextSnapshotV1>, reference: string) {
  const referenceIndex = CONTEXT_REFERENCE_KINDS.findIndex(([candidate]) => candidate === reference);
  const linked = context.evidence[referenceIndex];
  if (linked === undefined) throw new TypeError("context evidence required");
  return linked;
}

export function task18Request(context: ReturnType<typeof parseContextSnapshotV1>, id = RECOMMENDATION_ID) {
  const ranking = task18Ranking();
  const contextDigest = canonicalPersonalContractHash(context);
  const citationKinds: Readonly<Record<string, "principle" | "policy" | "owner" | "current" | "deadline" | "dependency" | "stable_identity">> = {
    confirmed_principle_ref: "principle",
    confirmed_principle_evidence_ref: "principle",
    linux_policy_decision_ref: "policy",
    owner_import_decision_ref: "owner",
    current_linux_evidence_ref: "current",
    deadline_evidence_ref: "deadline",
    dependency_evidence_ref: "dependency",
    owner_gate_ref: "owner",
    stable_identity_evidence_ref: "stable_identity",
  };
  const selected = ranking.actions.filter(action => action.rank !== null);
  const citations = new Map<string, (typeof citationKinds)[keyof typeof citationKinds]>();
  for (const action of selected) {
    for (const [key, ref] of Object.entries(action.rationale.citations)) {
      const kind = citationKinds[key];
      if (ref !== null && kind !== undefined) citations.set(ref, kind);
    }
  }
  return {
    id, idempotency_key: `idem:pos:v1:recommendation:${createHash("sha256").update(id).digest("hex")}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    context_id: context.id, context_digest: contextDigest, expires_at: RECOMMENDATION_EXPIRES,
    ranking, actions: selected.map(action => ({ action_id: action.action_id,
      title: `Next: ${action.action_id}`, operation: "review", target_digest: digest(action.action_id) })),
    linux_evidence: [...citations].map(([ref, kind]) => {
      if (kind === "policy") return { ref, kind, context_evidence_id: null, digest: contextDigest };
      const linked = task18EvidenceForReference(context, ref);
      return { ref, kind, context_evidence_id: linked.evidence_id, digest: linked.digest };
    }),
    approval_requirement: "owner", confidence_class: "high",
  };
}
