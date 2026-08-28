import type Database from "better-sqlite3";
import type { RecommendationV1, Sha256Digest } from "./personal-contracts.js";
import {
  PersonalContractError,
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseRecommendationV1,
} from "./personal-validation.js";
import {
  isApprovalRequirement,
  isConfidenceClass,
  type RecommendationPersistenceInput,
  type StoredRecommendation,
} from "./personal-recommendation-types.js";
import {
  type PersistenceErrorFactory,
  type PersistenceRow,
  isPersistenceTime,
  persistenceHash,
  persistenceRow,
  persistenceText,
  recordPersonalAudit,
  requireAdvisory,
} from "./personal-persistence-values.js";

export class PersonalRecommendationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  private parse(value: unknown): RecommendationV1 {
    try {
      return parseRecommendationV1(value);
    } catch (error) {
      if (error instanceof PersonalContractError) throw this.error("PERSONAL_RECOMMENDATION_INVALID");
      throw error;
    }
  }

  persist(value: RecommendationPersistenceInput, now: string): StoredRecommendation {
    if (!isPersistenceTime(now)) throw this.error("PERSONAL_TIME_INVALID");
    if (!isApprovalRequirement(value.approval_requirement)
      || !isConfidenceClass(value.confidence_class)) {
      throw this.error("PERSONAL_RECOMMENDATION_INVALID");
    }
    const recommendation = this.parse(value.recommendation);
    requireAdvisory(recommendation.authority, this.error, "PERSONAL_RECOMMENDATION_INVALID");
    const canonicalDigest = canonicalPersonalContractHash(recommendation);
    const evidenceDigest = persistenceHash(recommendation.evidence);
    const persistenceDigest = persistenceHash({
      approval_requirement: value.approval_requirement,
      canonical_digest: canonicalDigest,
      confidence_class: value.confidence_class,
    });
    const envelope = canonicalPersonalContractJson(recommendation);
    return this.database.transaction(() => this.insert({
      canonicalDigest,
      envelope,
      evidenceDigest,
      input: value,
      now,
      persistenceDigest,
      recommendation,
    }))();
  }

  private insert(input: {
    readonly canonicalDigest: Sha256Digest;
    readonly envelope: string;
    readonly evidenceDigest: Sha256Digest;
    readonly input: RecommendationPersistenceInput;
    readonly now: string;
    readonly persistenceDigest: Sha256Digest;
    readonly recommendation: RecommendationV1;
  }): StoredRecommendation {
    const priorIdentity = this.database.prepare(
      "SELECT idempotency_key,canonical_digest,evidence_digest,persistence_digest FROM personal_recommendations WHERE recommendation_id=?",
    ).get(input.recommendation.id);
    if (priorIdentity !== undefined) return this.replay(input, persistenceRow(priorIdentity));
    const priorKey = this.database.prepare(
      "SELECT recommendation_id FROM personal_recommendations WHERE idempotency_key=?",
    ).get(input.recommendation.idempotency_key);
    if (priorKey !== undefined) throw this.error("PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT");
    if (Date.parse(input.recommendation.expires_at) <= Date.parse(input.now)) {
      throw this.error("PERSONAL_RECOMMENDATION_EXPIRED");
    }
    const contextValue = this.database.prepare(
      `SELECT canonical_digest,expires_at,payload_state,freshness_state,fresh_until,evidence_count
       FROM personal_context_snapshots WHERE context_id=?`,
    ).get(input.recommendation.payload.context_id);
    if (contextValue === undefined) throw this.error("PERSONAL_RECOMMENDATION_INVALID");
    const context = persistenceRow(contextValue);
    if (context["canonical_digest"] !== input.recommendation.payload.context_digest) {
      throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT");
    }
    if (Date.parse(persistenceText(context["expires_at"])) <= Date.parse(input.now)) {
      throw this.error("PERSONAL_CONTEXT_EXPIRED");
    }
    if (Date.parse(input.recommendation.expires_at) > Date.parse(persistenceText(context["expires_at"]))) {
      throw this.error("PERSONAL_RECOMMENDATION_CONTEXT_EXPIRY_CONFLICT");
    }
    this.requireEvidence(input.recommendation, context, input.now);
    this.insertRecommendation(input);
    return {
      recommendation_id: input.recommendation.id,
      canonical_digest: input.canonicalDigest,
      evidence_digest: input.evidenceDigest,
    };
  }

  private requireEvidence(
    recommendation: RecommendationV1,
    context: PersistenceRow,
    now: string,
  ): void {
    const linked = this.database.prepare(
      `SELECT evidence_id,source_id,evidence_kind,evidence_digest,observed_at,
              freshness_state,fresh_until
       FROM personal_context_evidence WHERE context_id=? ORDER BY position`,
    ).all(recommendation.payload.context_id).map(persistenceRow);
    const exactSet = recommendation.evidence.length === linked.length
      && recommendation.evidence.every((item, position) => {
        const row = linked[position];
        return row !== undefined
          && row["evidence_id"] === item.evidence_id
          && row["source_id"] === item.source_id
          && row["evidence_kind"] === item.kind
          && row["evidence_digest"] === item.digest
          && row["observed_at"] === item.observed_at;
      });
    const foreignCitation = recommendation.payload.citations.some(citation => (
      !recommendation.evidence.some(item => item.evidence_id === citation)
    ));
    if (!exactSet || foreignCitation) throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT");
    const current = ["eligible", "presented", "selected"].includes(recommendation.payload.state);
    if (!current) return;
    if (recommendation.evidence.length === 0 || recommendation.freshness.state !== "fresh"
      || Date.parse(recommendation.freshness.fresh_until) <= Date.parse(now)
      || context["payload_state"] !== "sufficient"
      || context["freshness_state"] !== "fresh"
      || Date.parse(persistenceText(context["fresh_until"])) <= Date.parse(now)
      || linked.some(row => row["freshness_state"] !== "fresh"
        || Date.parse(persistenceText(row["fresh_until"])) <= Date.parse(now))) {
      throw this.error("PERSONAL_RECOMMENDATION_STALE");
    }
  }

  private replay(
    input: {
      readonly canonicalDigest: Sha256Digest;
      readonly evidenceDigest: Sha256Digest;
      readonly persistenceDigest: Sha256Digest;
      readonly recommendation: RecommendationV1;
    },
    prior: PersistenceRow,
  ): StoredRecommendation {
    if (prior["idempotency_key"] !== input.recommendation.idempotency_key
      || prior["canonical_digest"] !== input.canonicalDigest
      || prior["evidence_digest"] !== input.evidenceDigest
      || prior["persistence_digest"] !== input.persistenceDigest) {
      throw this.error("PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT");
    }
    return {
      recommendation_id: input.recommendation.id,
      canonical_digest: input.canonicalDigest,
      evidence_digest: input.evidenceDigest,
    };
  }

  private insertRecommendation(input: {
    readonly canonicalDigest: Sha256Digest;
    readonly envelope: string;
    readonly evidenceDigest: Sha256Digest;
    readonly input: RecommendationPersistenceInput;
    readonly now: string;
    readonly persistenceDigest: Sha256Digest;
    readonly recommendation: RecommendationV1;
  }): void {
    const recommendation = input.recommendation;
    this.database.prepare(
      `INSERT INTO personal_recommendations(
         recommendation_id,idempotency_key,context_id,context_digest,canonical_digest,evidence_digest,
         persistence_digest,canonical_envelope_json,approval_requirement,confidence_class,lifecycle_state,
         observed_at,valid_at,expires_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      recommendation.id,
      recommendation.idempotency_key,
      recommendation.payload.context_id,
      recommendation.payload.context_digest,
      input.canonicalDigest,
      input.evidenceDigest,
      input.persistenceDigest,
      input.envelope,
      input.input.approval_requirement,
      input.input.confidence_class,
      recommendation.payload.state,
      recommendation.observed_at,
      recommendation.valid_at,
      recommendation.expires_at,
      recommendation.created_at,
    );
    recommendation.evidence.forEach((item, position) => {
      this.database.prepare(
        "INSERT INTO personal_recommendation_evidence(recommendation_id,position,evidence_id,source_id,evidence_digest,observed_at) VALUES(?,?,?,?,?,?)",
      ).run(recommendation.id, position, item.evidence_id, item.source_id, item.digest, item.observed_at);
    });
    recommendation.payload.actions.forEach(item => {
      this.database.prepare(
        "INSERT INTO personal_recommendation_actions(recommendation_id,rank,title,operation,target_digest,initial_state) VALUES(?,?,?,?,?,'pending')",
      ).run(recommendation.id, item.rank, item.title, item.operation, item.target_digest);
      this.database.prepare(
        "INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,'pending',?,?)",
      ).run(recommendation.id, item.rank, input.evidenceDigest, input.now);
    });
    recordPersonalAudit(this.database, {
      event: "recommendation_recorded",
      subject: recommendation.id,
      digest: input.canonicalDigest,
      correlation: recommendation.correlation_id,
      causation: recommendation.causation_id,
      occurredAt: input.now,
    });
  }

}
