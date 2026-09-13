import { createHash } from "node:crypto";
import {
  canonicalPersonalContractHash,
  normalizePersonalObservations,
  parseContextSnapshotV1,
  rankPriorityActions,
  type AuthorityDb,
  type OrcaTaskObservationInput,
  type PriorityEngineResult,
  type Sha256Digest,
} from "../../src/index.js";
import { approveFixtureOwnerDecision, sealFixtureAuthority, type FixtureOwnerApproval } from "./fixture-authority.js";
import { defaultPriorityCandidates } from "./priority-engine-candidates.js";
import { priorityEngineInput, priorityPolicyConfig } from "./priority-engine-input.js";

export const RECOMMENDATION_NOW = "2026-08-28T12:00:00.000Z";
/**
 * A context that cites live Linux facts cannot outlive them. An observation stays fresh for five
 * minutes from the check that produced it, and assembly refuses a context whose deadline reaches
 * past its own evidence - so this context expires inside that window and the recommendation
 * expires inside the context.
 */
export const CONTEXT_EXPIRES = "2026-08-28T12:04:00.000Z";
export const RECOMMENDATION_EXPIRES = "2026-08-28T12:03:00.000Z";
const CONTEXT_FRESH_UNTIL = "2026-08-28T12:03:59.999Z";
const OBSERVED_AT = "2026-08-28T11:59:00.000Z";
export const RECOMMENDATION_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7101";
export const REPLACEMENT_ID = "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7102";
const CONTEXT_ID = "ctx:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7100";

/** Cited as current Linux facts; each is a real verified live observation in the database. */
const LIVE_SLOTS = ["live:customer", "live:deadline", "live:dependency", "identity:customer-delivery",
  "live:worker", "identity:worker-implementation", "live:owner-gated", "identity:owner-gated-deploy"] as const;
/** Cited as confirmed principles; both are sealed under the kind the assembler writes for memory. */
const MEMORY_SLOTS = ["memory:principle:customer-first", "second-brain:sid:customer-first"] as const;
/** Rested on the owner; each is a real approved, owner-signed control-plane receipt. */
const OWNER_SLOTS = ["decision:owner:import", "request:owner:deploy"] as const;
/** How many control commands the context's own owner approvals put on record. */
export const TASK18_OWNER_APPROVALS = OWNER_SLOTS.length;

type ContextSnapshot = ReturnType<typeof parseContextSnapshotV1>;
type Task18Material = {
  readonly references: ReadonlyMap<string, string>;
  readonly approvals: ReadonlyMap<string, FixtureOwnerApproval>;
  readonly evidence: readonly { evidence_id: string; digest: string; kind: string;
    source_id: string; observed_at: string }[];
  readonly byReference: ReadonlyMap<string, { evidence_id: string; digest: string; kind: string;
    source_id: string; observed_at: string }>;
};
const material = new Map<string, Task18Material>();

function digest(value: string): Sha256Digest {
  const candidate = `sha256:${createHash("sha256").update(value).digest("hex")}`;
  function valid(item: string): item is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(item); }
  if (!valid(candidate)) throw new TypeError("fixture digest required");
  return candidate;
}
function evidenceId(index: number): string {
  return `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f72${String(index + 1).padStart(2, "0")}`;
}

/** One verified live Linux observation standing behind a reference an action cites as current. */
function liveTask(slot: string, index: number): OrcaTaskObservationInput {
  const key = slot.replaceAll(/[^a-z0-9]+/gi, "-");
  // Observations of one source have to advance, so each reference reports its task a second on.
  const observedAt = new Date(Date.parse(OBSERVED_AT) + index * 1_000).toISOString();
  return {
    environment: "local", worktree: "/home/jm/orca/workspaces/task18",
    worktree_id: `worktree-${key}`, terminal_id: `terminal-${key}`, session_id: `session-${key}`,
    incarnation_id: `incarnation-${key}`, pty_id: `pty-${key}`, cursor: `cursor-${key}`, working: true,
    timeline: { schema_version: 1, generated_at: RECOMMENDATION_NOW,
      task: { task_id: `task-${key}`, title: "not persisted", kind: "work", state: "running",
        updated_at: observedAt, pending_approval: false, source_ids: [`source-${key}`] },
      events: [{ event_id: `evidence-${key}`, task_id: `task-${key}`, source: "verification",
        kind: "evidence", actor: "verifier", title: "not persisted", status: "recorded",
        payload: { fact: "not persisted" }, evidence_refs: [`verify-${key}`],
        created_at: observedAt, sequence: 1 }],
      pending_decisions: [], workers: [], evidence: [], truncated: false },
  };
}

function task18Material(context: ContextSnapshot): Task18Material {
  const found = material.get(context.id);
  if (found === undefined) throw new TypeError("task18 context must be persisted by this fixture");
  return found;
}

/** Rewrites the fixture's readable slot names to the references the database can actually back. */
export function task18Substitute<T>(context: ContextSnapshot, value: T): T {
  const references = task18Material(context).references;
  const map = (item: unknown): unknown => {
    if (typeof item === "string") return references.get(item) ?? item;
    if (Array.isArray(item)) return item.map(map);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, map(entry)]));
    }
    return item;
  };
  return map(value) as T;
}

/** The reference a slot name resolves to once the fixture has persisted what backs it. */
export function task18Reference(context: ContextSnapshot, slot: string): string {
  const reference = task18Material(context).references.get(slot);
  if (reference === undefined) throw new TypeError(`task18 slot ${slot} not persisted`);
  return reference;
}

/** The whole cited context: eight verified live observations and two confirmed principles. */
export async function persistTask18Context(db: AuthorityDb, expiresAt = CONTEXT_EXPIRES) {
  await sealFixtureAuthority(db);
  const references = new Map<string, string>();
  const approvals = new Map<string, FixtureOwnerApproval>();
  const observations = LIVE_SLOTS.map((slot, index) => {
    const [observation] = normalizePersonalObservations({ checked_at: RECOMMENDATION_NOW,
      orca_tasks: [liveTask(slot, index)], portfolios: [] });
    if (observation === undefined) throw new TypeError("task18 observation required");
    const stored = db.persistObservation(observation, RECOMMENDATION_NOW);
    references.set(slot, observation.id);
    return { reference: observation.id, digest: stored.canonical_digest,
      source_id: observation.source.source_id, observed_at: observation.observed_at };
  });
  for (const [index, slot] of OWNER_SLOTS.entries()) {
    const approval = approveFixtureOwnerDecision(db, `req:pos:v1:task18:owner:${index + 1}`, RECOMMENDATION_NOW);
    references.set(slot, approval.request_id);
    approvals.set(approval.request_id, approval);
  }
  const evidence = [
    ...observations.map((item, index) => ({ evidence_id: evidenceId(index), digest: item.digest,
      kind: "context_observation", source_id: item.source_id, observed_at: item.observed_at })),
    ...MEMORY_SLOTS.map((slot, index) => ({ evidence_id: evidenceId(LIVE_SLOTS.length + index),
      digest: digest(`evidence:${slot}`), kind: "confirmed_memory",
      source_id: "src:pos:v1:second-brain:primary", observed_at: OBSERVED_AT })),
  ];
  const context = parseContextSnapshotV1({
    schema_version: 1, id: CONTEXT_ID, created_at: RECOMMENDATION_NOW,
    observed_at: OBSERVED_AT, valid_at: OBSERVED_AT,
    source: { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority",
      host_id: "host:pos:linux-control-plane", source_version: "task15-v1", evidence_ref: "context:task18" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: RECOMMENDATION_NOW, fresh_until: CONTEXT_FRESH_UNTIL },
    expires_at: expiresAt, idempotency_key: `idem:pos:v1:context:${"1".repeat(64)}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    payload: { purpose: "daily_prioritization", query: "What should happen next?",
      included_observation_refs: observations.map(item => item.reference),
      included_memory_refs: [...MEMORY_SLOTS], excluded_refs: [], pending_authority_refs: [],
      conflicts: ["calendar and customer dates differ"], omissions: ["mail unavailable"],
      budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" },
    policy_decision: { decision: "allow", policy_version: "policy-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence, receipt: null,
  });
  db.persistContextSnapshot({ context, memory_evidence: MEMORY_SLOTS.map((slot, index) => {
    const item = evidence[LIVE_SLOTS.length + index];
    if (item === undefined) throw new TypeError("task18 memory evidence required");
    return { memory_ref: slot, evidence_id: item.evidence_id, source_id: item.source_id,
      digest: item.digest, observed_at: item.observed_at, fresh_until: context.expires_at };
  }) }, RECOMMENDATION_NOW);
  const byReference = new Map<string, (typeof evidence)[number]>();
  LIVE_SLOTS.forEach((slot, index) => {
    const item = evidence[index];
    if (item === undefined) throw new TypeError("task18 observation evidence required");
    byReference.set(slot, item);
    byReference.set(references.get(slot) ?? slot, item);
  });
  MEMORY_SLOTS.forEach((slot, index) => {
    const item = evidence[LIVE_SLOTS.length + index];
    if (item === undefined) throw new TypeError("task18 memory evidence required");
    byReference.set(slot, item);
  });
  material.set(context.id, { references, approvals, evidence, byReference });
  return context;
}

export function task18Ranking(context: ContextSnapshot): PriorityEngineResult {
  const wanted = new Set(["customer-delivery", "worker-implementation", "owner-gated-deploy"]);
  const candidates = defaultPriorityCandidates().filter(candidate => wanted.has(String(candidate["action_id"])));
  return rankPriorityActions(priorityPolicyConfig(), task18Substitute(context, priorityEngineInput({ candidates })));
}

export function task18EvidenceForReference(context: ContextSnapshot, reference: string) {
  const linked = task18Material(context).byReference.get(reference);
  if (linked === undefined) throw new TypeError("context evidence required");
  return linked;
}

export function task18Request(context: ContextSnapshot, id = RECOMMENDATION_ID) {
  const ranking = task18Ranking(context);
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
    for (const [key, reference] of Object.entries(action.rationale.citations)) {
      const kind = citationKinds[key];
      if (reference !== null && kind !== undefined) citations.set(reference, kind);
    }
  }
  const approvals = task18Material(context).approvals;
  return {
    id, idempotency_key: `idem:pos:v1:recommendation:${createHash("sha256").update(id).digest("hex")}`,
    correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
    context_id: context.id, context_digest: contextDigest, expires_at: RECOMMENDATION_EXPIRES,
    ranking, actions: selected.map(action => ({ action_id: action.action_id,
      title: `Next: ${action.action_id}`, operation: "review", target_digest: digest(action.action_id) })),
    // A citation either names context evidence, or rests on authority the context never held:
    // the policy decision, and the owner's approval receipt from the control plane.
    linux_evidence: [...citations].map(([ref, kind]) => {
      if (kind === "policy") return { ref, kind, context_evidence_id: null, digest: contextDigest };
      const approval = approvals.get(ref);
      if (approval !== undefined) {
        return { ref, kind, context_evidence_id: null, digest: approval.command_digest };
      }
      const linked = task18EvidenceForReference(context, ref);
      return { ref, kind, context_evidence_id: linked.evidence_id, digest: linked.digest };
    }),
    approval_requirement: "owner", confidence_class: "high",
  };
}
