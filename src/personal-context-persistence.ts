import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { ContextId, ObservationId, RecommendationId, Sha256Digest } from "./personal-contracts.js";
import { PersonalContractError, canonicalPersonalContractHash, canonicalPersonalContractJson, parseContextSnapshotV1, parseObservationEnvelopeV1, parseRecommendationV1 } from "./personal-validation.js";

const APPROVAL_REQUIREMENTS = ["none", "owner"] as const;
const CONFIDENCE_CLASSES = ["low", "medium", "high"] as const;
const ACTION_STATES = ["pending", "accepted", "rejected", "expired", "superseded"] as const;
type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];
type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];
type ActionState = (typeof ACTION_STATES)[number];
type Row = Readonly<Record<string, unknown>>;
type ErrorFactory = (code: string) => Error;
export type RecommendationPersistenceInput = { readonly recommendation: unknown; readonly approval_requirement: ApprovalRequirement; readonly confidence_class: ConfidenceClass };
export type RecommendationActionTransition = { readonly recommendation_id: RecommendationId; readonly rank: number; readonly state: Exclude<ActionState, "pending">; readonly evidence_digest: Sha256Digest; readonly occurred_at: string };
export type StoredObservation = { readonly observation_id: ObservationId; readonly canonical_digest: Sha256Digest; readonly inserted: boolean; readonly checkpoint_sequence: number | null };
export type StoredContext = { readonly context_id: ContextId; readonly canonical_digest: Sha256Digest; readonly version: number; readonly observation_count: number };
export type StoredRecommendation = { readonly recommendation_id: RecommendationId; readonly canonical_digest: Sha256Digest; readonly evidence_digest: Sha256Digest };
export type ReconstructedRecommendation = { readonly recommendation: Row; readonly evidence: readonly Row[]; readonly actions: readonly Row[]; readonly action_events: readonly Row[] };

function isRecord(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Row { if (!isRecord(value)) throw new TypeError("database row required"); return value; }
function text(value: unknown): string { if (typeof value !== "string") throw new TypeError("database text required"); return value; }
function number(value: unknown): number { if (typeof value !== "number") throw new TypeError("database number required"); return value; }
function validNow(value: string): boolean { return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(Date.parse(value)).toISOString() === value; }
function isDigest(value: string): value is Sha256Digest { return /^sha256:[0-9a-f]{64}$/.test(value); }
function hash(value: unknown): Sha256Digest { const result = `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`; if (!isDigest(result)) throw new TypeError("canonical digest required"); return result; }
function includes<Value extends string>(values: readonly Value[], value: string): value is Value { return values.some(candidate => candidate === value); }
function contextOversize(value: unknown): boolean {
  if (!isRecord(value)) return false; const payload = value["payload"]; if (!isRecord(payload)) return false;
  return ["included_observation_refs", "included_memory_refs", "excluded_refs", "pending_authority_refs", "conflicts", "omissions"].some(key => Array.isArray(payload[key]) && payload[key].length > 32);
}

export class PersonalContextPersistence {
  constructor(private readonly database: Database.Database, private readonly error: ErrorFactory) {}
  private now(value: string): void { if (!validNow(value)) throw this.error("PERSONAL_TIME_INVALID"); }
  private audit(event: string, subject: string, digest: string, correlation: string, causation: string | null, at: string): void {
    this.database.prepare("INSERT INTO personal_context_audit_events(event_type,subject_id,subject_digest,correlation_id,causation_id,occurred_at) VALUES(?,?,?,?,?,?)").run(event, subject, digest, correlation, causation, at);
  }
  persistObservation(value: unknown, now: string): StoredObservation {
    this.now(now); let observation;
    try { observation = parseObservationEnvelopeV1(value); } catch (error) { if (error instanceof PersonalContractError) throw this.error("PERSONAL_OBSERVATION_INVALID"); throw error; }
    if (Date.parse(observation.observed_at) > Date.parse(now) || Date.parse(observation.created_at) > Date.parse(now)) throw this.error("PERSONAL_OBSERVATION_FUTURE");
    const canonicalDigest = canonicalPersonalContractHash(observation); const envelope = canonicalPersonalContractJson(observation);
    return this.database.transaction(() => {
      const priorValue = this.database.prepare("SELECT canonical_digest FROM personal_observations WHERE observation_id=?").get(observation.id);
      if (priorValue !== undefined) { if (text(record(priorValue)["canonical_digest"]) !== canonicalDigest) throw this.error("PERSONAL_OBSERVATION_IDENTITY_CONFLICT"); return { observation_id: observation.id, canonical_digest: canonicalDigest, inserted: false, checkpoint_sequence: null }; }
      let checkpointSequence: number | null = null;
      if (observation.payload.checkpoint !== null) {
        const latestValue = this.database.prepare("SELECT sequence,checkpoint,observation_id,observed_at FROM personal_source_checkpoints WHERE source_id=? ORDER BY sequence DESC LIMIT 1").get(observation.source.source_id);
        if (latestValue !== undefined) {
          const latest = record(latestValue);
          if (text(latest["checkpoint"]) === observation.payload.checkpoint) throw this.error("PERSONAL_CHECKPOINT_REPLAY_CONFLICT");
          if (Date.parse(observation.observed_at) <= Date.parse(text(latest["observed_at"]))) throw this.error("PERSONAL_CHECKPOINT_STALE");
          checkpointSequence = number(latest["sequence"]) + 1;
        } else checkpointSequence = 1;
      }
      this.database.prepare("INSERT INTO personal_observations(observation_id,source_id,checkpoint,canonical_digest,content_digest,canonical_envelope_json,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(observation.id, observation.source.source_id, observation.payload.checkpoint, canonicalDigest, observation.payload.content_digest, envelope, observation.observed_at, observation.valid_at, observation.expires_at, observation.created_at);
      this.audit("observation_recorded", observation.id, canonicalDigest, observation.correlation_id, observation.causation_id, now);
      if (checkpointSequence !== null) { this.database.prepare("INSERT INTO personal_source_checkpoints(source_id,sequence,checkpoint,observation_id,observation_digest,observed_at,recorded_at) VALUES(?,?,?,?,?,?,?)").run(observation.source.source_id, checkpointSequence, observation.payload.checkpoint, observation.id, canonicalDigest, observation.observed_at, now); this.audit("checkpoint_advanced", `${observation.source.source_id}:${checkpointSequence}`, canonicalDigest, observation.correlation_id, observation.causation_id, now); }
      return { observation_id: observation.id, canonical_digest: canonicalDigest, inserted: true, checkpoint_sequence: checkpointSequence };
    })();
  }
  persistContext(value: unknown, now: string): StoredContext {
    this.now(now); let context;
    try { context = parseContextSnapshotV1(value); } catch (error) { if (error instanceof PersonalContractError) throw this.error(contextOversize(value) ? "PERSONAL_CONTEXT_OVERSIZE" : "PERSONAL_CONTEXT_INVALID"); throw error; }
    if (Date.parse(context.expires_at) <= Date.parse(now)) throw this.error("PERSONAL_CONTEXT_EXPIRED");
    const canonicalDigest = canonicalPersonalContractHash(context); const envelope = canonicalPersonalContractJson(context);
    return this.database.transaction(() => {
      const priorValue = this.database.prepare("SELECT canonical_digest,version,item_count FROM personal_context_snapshots WHERE context_id=?").get(context.id);
      if (priorValue !== undefined) { const prior = record(priorValue); if (text(prior["canonical_digest"]) !== canonicalDigest) throw this.error("PERSONAL_CONTEXT_INVALID"); return { context_id: context.id, canonical_digest: canonicalDigest, version: number(prior["version"]), observation_count: number(prior["item_count"]) }; }
      const observations = context.payload.included_observation_refs.map(reference => {
        const value = this.database.prepare("SELECT observation_id,source_id,canonical_digest,expires_at FROM personal_observations WHERE observation_id=?").get(reference); if (value === undefined) throw this.error("PERSONAL_CONTEXT_INVALID"); const stored = record(value);
        if (Date.parse(text(stored["expires_at"])) <= Date.parse(now)) throw this.error("PERSONAL_CONTEXT_SOURCE_EXPIRED");
        if (!context.evidence.some(item => item.digest === stored["canonical_digest"] && item.source_id === stored["source_id"])) throw this.error("PERSONAL_CONTEXT_INVALID"); return stored;
      });
      const versionValue = this.database.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM personal_context_snapshots WHERE purpose=? AND declared_query=?").get(context.payload.purpose, context.payload.query); const version = number(record(versionValue)["version"]);
      const itemCount = context.payload.included_observation_refs.length + context.payload.included_memory_refs.length + context.payload.excluded_refs.length + context.payload.pending_authority_refs.length + context.payload.conflicts.length + context.payload.omissions.length;
      this.database.prepare("INSERT INTO personal_context_snapshots(context_id,purpose,declared_query,version,canonical_digest,canonical_envelope_json,item_count,max_items,max_excerpt_bytes,max_total_bytes,conflict_count,omission_count,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(context.id, context.payload.purpose, context.payload.query, version, canonicalDigest, envelope, itemCount, context.payload.budgets.max_items, context.payload.budgets.max_excerpt_bytes, context.payload.budgets.max_total_bytes, context.payload.conflicts.length, context.payload.omissions.length, context.observed_at, context.valid_at, context.expires_at, context.created_at);
      observations.forEach((observation, position) => this.database.prepare("INSERT INTO personal_context_observations(context_id,position,observation_id,observation_digest) VALUES(?,?,?,?)").run(context.id, position, observation["observation_id"], observation["canonical_digest"]));
      this.audit("context_recorded", context.id, canonicalDigest, context.correlation_id, context.causation_id, now); return { context_id: context.id, canonical_digest: canonicalDigest, version, observation_count: observations.length };
    })();
  }
  persistRecommendation(value: RecommendationPersistenceInput, now: string): StoredRecommendation {
    this.now(now); if (!includes(APPROVAL_REQUIREMENTS, value.approval_requirement) || !includes(CONFIDENCE_CLASSES, value.confidence_class)) throw this.error("PERSONAL_RECOMMENDATION_INVALID"); let recommendation;
    try { recommendation = parseRecommendationV1(value.recommendation); } catch (error) { if (error instanceof PersonalContractError) throw this.error("PERSONAL_RECOMMENDATION_INVALID"); throw error; }
    if (Date.parse(recommendation.expires_at) <= Date.parse(now)) throw this.error("PERSONAL_RECOMMENDATION_EXPIRED");
    const canonicalDigest = canonicalPersonalContractHash(recommendation); const evidenceDigest = hash(recommendation.evidence); const envelope = canonicalPersonalContractJson(recommendation);
    return this.database.transaction(() => {
      const contextValue = this.database.prepare("SELECT canonical_digest,expires_at FROM personal_context_snapshots WHERE context_id=?").get(recommendation.payload.context_id); if (contextValue === undefined) throw this.error("PERSONAL_RECOMMENDATION_INVALID"); const context = record(contextValue);
      if (context["canonical_digest"] !== recommendation.payload.context_digest) throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT"); if (Date.parse(text(context["expires_at"])) <= Date.parse(now)) throw this.error("PERSONAL_CONTEXT_EXPIRED");
      const linked = this.database.prepare("SELECT o.source_id,o.canonical_digest FROM personal_context_observations l JOIN personal_observations o ON o.observation_id=l.observation_id WHERE l.context_id=?").all(recommendation.payload.context_id).map(record);
      if (recommendation.evidence.some(item => !linked.some(row => row["source_id"] === item.source_id && row["canonical_digest"] === item.digest)) || recommendation.payload.citations.some(citation => !recommendation.evidence.some(item => item.evidence_id === citation))) throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT");
      const priorValue = this.database.prepare("SELECT canonical_digest,evidence_digest FROM personal_recommendations WHERE recommendation_id=?").get(recommendation.id); if (priorValue !== undefined) { const prior = record(priorValue); if (prior["canonical_digest"] !== canonicalDigest || prior["evidence_digest"] !== evidenceDigest) throw this.error("PERSONAL_RECOMMENDATION_INVALID"); return { recommendation_id: recommendation.id, canonical_digest: canonicalDigest, evidence_digest: evidenceDigest }; }
      this.database.prepare("INSERT INTO personal_recommendations(recommendation_id,context_id,context_digest,canonical_digest,evidence_digest,canonical_envelope_json,approval_requirement,confidence_class,lifecycle_state,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(recommendation.id, recommendation.payload.context_id, recommendation.payload.context_digest, canonicalDigest, evidenceDigest, envelope, value.approval_requirement, value.confidence_class, recommendation.payload.state, recommendation.observed_at, recommendation.valid_at, recommendation.expires_at, recommendation.created_at);
      recommendation.evidence.forEach((item, position) => this.database.prepare("INSERT INTO personal_recommendation_evidence(recommendation_id,position,evidence_id,source_id,evidence_digest,observed_at) VALUES(?,?,?,?,?,?)").run(recommendation.id, position, item.evidence_id, item.source_id, item.digest, item.observed_at));
      recommendation.payload.actions.forEach(item => { this.database.prepare("INSERT INTO personal_recommendation_actions(recommendation_id,rank,title,operation,target_digest,initial_state) VALUES(?,?,?,?,?,'pending')").run(recommendation.id, item.rank, item.title, item.operation, item.target_digest); this.database.prepare("INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,'pending',?,?)").run(recommendation.id, item.rank, evidenceDigest, now); });
      this.audit("recommendation_recorded", recommendation.id, canonicalDigest, recommendation.correlation_id, recommendation.causation_id, now); return { recommendation_id: recommendation.id, canonical_digest: canonicalDigest, evidence_digest: evidenceDigest };
    })();
  }
  transitionAction(input: RecommendationActionTransition): void {
    this.now(input.occurred_at); if (!Number.isInteger(input.rank) || input.rank < 1 || !includes(ACTION_STATES, input.state)) throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    this.database.transaction(() => { const value = this.database.prepare("SELECT r.evidence_digest,r.expires_at,(SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS state FROM personal_recommendation_actions a JOIN personal_recommendations r ON r.recommendation_id=a.recommendation_id WHERE a.recommendation_id=? AND a.rank=?").get(input.recommendation_id, input.rank); if (value === undefined) throw this.error("PERSONAL_ACTION_STATE_CONFLICT"); const action = record(value);
      if (action["evidence_digest"] !== input.evidence_digest) throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT"); if (Date.parse(text(action["expires_at"])) <= Date.parse(input.occurred_at)) throw this.error("PERSONAL_RECOMMENDATION_EXPIRED"); if (action["state"] !== "pending") throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
      this.database.prepare("INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,?,?,?)").run(input.recommendation_id, input.rank, input.state, input.evidence_digest, input.occurred_at); this.audit("action_state_recorded", `${input.recommendation_id}:${input.rank}:${input.state}`, input.evidence_digest, input.recommendation_id, null, input.occurred_at);
    })();
  }
  getRecommendation(id: RecommendationId): ReconstructedRecommendation | undefined {
    const value = this.database.prepare("SELECT recommendation_id,context_id,context_digest,canonical_digest,evidence_digest,approval_requirement,confidence_class,lifecycle_state,expires_at,created_at FROM personal_recommendations WHERE recommendation_id=?").get(id); if (value === undefined) return undefined;
    const evidence = this.database.prepare("SELECT evidence_id,source_id,evidence_digest AS digest,observed_at FROM personal_recommendation_evidence WHERE recommendation_id=? ORDER BY position").all(id).map(record);
    const actions = this.database.prepare("SELECT a.rank,a.title,a.operation,a.target_digest,(SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS state FROM personal_recommendation_actions a WHERE a.recommendation_id=? ORDER BY a.rank").all(id).map(record);
    const events = this.database.prepare("SELECT rank,state,evidence_digest,occurred_at FROM personal_recommendation_action_events WHERE recommendation_id=? ORDER BY event_sequence").all(id).map(record); return { recommendation: record(value), evidence, actions, action_events: events };
  }
}
