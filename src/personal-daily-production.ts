import { createHash } from "node:crypto";
import { assemblePersonalContext } from "./context-assembler.js";
import type { ContextAssemblerInput, MemoryEvidenceInput, MemoryInput } from "./context-assembler-input.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { readCurrentLocalTimelineObservation } from "./local-timeline-observation.js";
import type { PreparedMemoryReference } from "./memory-reference-context.js";
import { classifyAssembledCitations } from "./personal-context-citation-contract.js";
import { produceDailyRecommendation } from "./personal-context-production.js";
import { contextMemoryFromReference, ownerImportDecisionFor } from "./personal-memory-reference-evidence.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import { parseObservationEnvelopeV1 } from "./personal-validation.js";

const LOCAL_TIMELINE_SOURCE = "src:pos:v1:task-timeline:local";
const CONTEXT_WINDOW_MS = 240_000;
const RECOMMENDATION_WINDOW_MS = 180_000;

export type StoredDailyProduction =
  | { readonly state: "produced"; readonly context_id: string; readonly recommendation_id: string }
  | { readonly state: "withheld"; readonly reason: string; readonly context_id: string | null };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function identity(value: string): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The authorization the owner signed for the workflow a proposal would belong to.
 *
 * JARVIS proposes; it does not authorize itself. A proposal may only be made inside a workflow the
 * owner started for that work, and that start is an approved, unrevoked, owner-signed control
 * request naming the subject. An authorization for other work is not an authorization for this one,
 * so a fact the owner authorized no work on cannot even be proposed, and a run with no authorized
 * fact at all withholds instead.
 */
function ownerWorkflowAuthorization(authority: AuthorityDb, subject: string, now: Date): string | null {
  const value = authority.db.prepare(
    `SELECT r.request_id FROM control_command_requests r
     JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve'
       AND a.command_digest=r.command_digest AND a.signer_principal_id='principal:owner'
     JOIN trusted_authority_keys k ON k.key_id=a.key_id AND k.principal_id=a.signer_principal_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE r.action='workflow.start' AND r.requested_by='principal:owner'
       AND r.state IN ('approved','claimed','completed') AND r.expires_at>?
       AND json_valid(r.target_json) AND json_valid(r.args_json)
       AND (json_extract(r.target_json,'$.task_id')=?
         OR json_extract(r.args_json,'$.correlation_id')=?
         OR json_extract(r.args_json,'$.input.task_id')=?)
       AND NOT EXISTS(SELECT 1 FROM control_command_revocations v
         WHERE v.request_id=r.request_id OR v.receipt_id=a.receipt_id)
     ORDER BY r.requested_at DESC,r.request_id LIMIT 1`).pluck()
    .get(now.toISOString(), subject, subject, subject);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The observations this database holds that are still current at this instant.
 *
 * A local timeline collection is asked whether it still matches its source, the way the context
 * store asks before it will accept one: an observation whose cache moved on is left out here rather
 * than refused later, so a replaced collection withholds the run instead of failing it.
 */
function currentObservations(authority: AuthorityDb, now: Date): readonly ObservationEnvelopeV1[] {
  const rows = authority.db.prepare(
    `SELECT observation_id,source_id,canonical_envelope_json FROM personal_observations
     WHERE expires_at>? ORDER BY observed_at,observation_id LIMIT 64`).all(now.toISOString()) as
    { observation_id: string; source_id: string; canonical_envelope_json: string }[];
  const observations: ObservationEnvelopeV1[] = [];
  for (const row of rows) {
    if (row.source_id === LOCAL_TIMELINE_SOURCE) {
      try { readCurrentLocalTimelineObservation({ db: authority.db }, row.observation_id, () => now); }
      catch (error) { if (error instanceof JarvisError) continue; throw error; }
    }
    observations.push(parseObservationEnvelopeV1(JSON.parse(row.canonical_envelope_json)));
  }
  return observations;
}

/**
 * One morning's production, derived from what this database already holds.
 *
 * Nothing here is declared by a caller. The memories are whatever the reference seam returned for a
 * provider read - the caller hands over the read, not a trust level, and the seam answers each
 * record from this database's own settled writes and owner decisions. The principle is the first
 * memory that survived that, the decision that admitted it is the owner's own confirmation request
 * named by the same seam, and a candidate exists only where an observation can actually be cited as
 * a current Linux fact.
 *
 * Where any of those is missing the run withholds before assembling anything, so nothing at all is
 * written - not even a context. That is a result rather than a failure: a deployment with no memory
 * provider still publishes what is on record. It is also a stronger statement than the one the
 * production chain inside can make, where an abstention decided by the ranking keeps the context it
 * assembled, because the brief reports what that context could and could not support.
 */
export function produceStoredDailyRecommendation(
  authority: AuthorityDb,
  options: {
    readonly now: Date;
    readonly policy: unknown;
    readonly policy_decision_ref: string;
    readonly memory_reference?: PreparedMemoryReference;
  },
): StoredDailyProduction {
  const now = options.now;
  const clock = now.toISOString();
  if (options.memory_reference === undefined) {
    return { state: "withheld", reason: "no_memory_reference", context_id: null };
  }
  const memories: readonly MemoryInput[] = contextMemoryFromReference(authority, options.memory_reference);
  // A gap is a memory the assembler must still see, so it stays in the assembled input; only the
  // citation authority is asked about the ones that actually carry evidence.
  const cited: readonly MemoryEvidenceInput[] = memories
    .filter((item): item is MemoryEvidenceInput => item.kind === "evidence");
  const principle = cited[0];
  if (principle === undefined) {
    return { state: "withheld", reason: "no_confirmed_principle", context_id: null };
  }
  const ownerImport = ownerImportDecisionFor(authority, principle.digest);
  if (ownerImport === null) return { state: "withheld", reason: "no_owner_import_decision", context_id: null };

  const observations = currentObservations(authority, now);
  if (observations.length === 0) return { state: "withheld", reason: "no_current_observation", context_id: null };

  const assemble: ContextAssemblerInput = { purpose: "daily_prioritization",
    query: "What should happen next?", clock, expires_in_ms: CONTEXT_WINDOW_MS,
    budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 },
    observations, pending_authority_refs: [], memories: [...memories] };

  // Which observations may be cited is decided before anything is written, so a run with nothing
  // citable withholds without leaving a context behind.
  const citations = classifyAssembledCitations(assemblePersonalContext(assemble), observations, cited);
  const facts = citations.citable.filter(item => item.citation_kind === "linux_live_fact");
  if (facts.length === 0) return { state: "withheld", reason: "no_citable_current_fact", context_id: null };

  const subjects = new Map(observations.map(item => [String(item.id), String(item.payload.subject)]));
  const candidates = facts.flatMap(fact => {
    const subject = subjects.get(fact.reference);
    const gate = subject === undefined ? null : ownerWorkflowAuthorization(authority, subject, now);
    if (gate === null) return [];
    return [{
      action_id: `review:${identity(fact.reference).slice(0, 8)}`,
      // Nothing here executes itself: the run proposes and the owner decides. That is also what puts
      // the item in front of them in the morning brief rather than leaving it a silent record.
      execution_mode: "jarvis", owner_safety_gate: "owner_approval_required", owner_gate_ref: gate,
      customer_impact: "internal", deadline: null, dependency: { kind: "non_blocking" },
      irreversible_risk: "low", effort_cost: "medium", principle_ref: principle.memory_ref,
      current_evidence_ref: fact.reference,
      stable_identity: { key: fact.reference, evidence_ref: fact.reference },
    }];
  });
  if (candidates.length === 0) {
    return { state: "withheld", reason: "no_owner_workflow_authorization", context_id: null };
  }

  const seed = digest(`daily-production/v1\u0000${clock}\u0000${candidates.map(item => item.action_id).join(",")}`);
  const production = produceDailyRecommendation(authority, {
    assemble, policy: options.policy, policy_decision_ref: options.policy_decision_ref,
    principle_ref: principle.memory_ref, owner_import_decision_ref: ownerImport, candidates,
    recommendation: { id: `rec:pos:v1:${identity(seed)}`,
      idempotency_key: `idem:pos:v1:recommendation:${seed}`,
      correlation_id: `corr:pos:v1:${identity(`correlation\u0000${seed}`)}`, causation_id: null,
      expires_at: new Date(now.getTime() + RECOMMENDATION_WINDOW_MS).toISOString(),
      confidence_class: "medium",
      actions: candidates.map(item => ({ action_id: item.action_id,
        title: `Next: ${item.action_id}`, operation: "review",
        target_digest: `sha256:${digest(item.action_id)}` })) },
  });
  return production.state === "recommended"
    ? { state: "produced", context_id: production.context.id,
      recommendation_id: production.created.recommendation.id }
    : { state: "withheld", reason: production.reasons.join(","), context_id: production.context.id };
}
