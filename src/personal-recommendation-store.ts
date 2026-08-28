import type Database from "better-sqlite3";
import type { RecommendationV1, Sha256Digest } from "./personal-contracts.js";
import {
  PersonalContractError,
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseRecommendationV1,
} from "./personal-validation.js";
import {
  isActionState,
  isApprovalRequirement,
  isConfidenceClass,
  type RecommendationActionTransition,
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
    if (Date.parse(recommendation.expires_at) <= Date.parse(now)) {
      throw this.error("PERSONAL_RECOMMENDATION_EXPIRED");
    }
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
    const contextValue = this.database.prepare(
      "SELECT canonical_digest,expires_at FROM personal_context_snapshots WHERE context_id=?",
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
    this.requireEvidence(input.recommendation);
    const priorIdentity = this.database.prepare(
      "SELECT idempotency_key,canonical_digest,evidence_digest,persistence_digest FROM personal_recommendations WHERE recommendation_id=?",
    ).get(input.recommendation.id);
    if (priorIdentity !== undefined) return this.replay(input, persistenceRow(priorIdentity));
    const priorKey = this.database.prepare(
      "SELECT recommendation_id FROM personal_recommendations WHERE idempotency_key=?",
    ).get(input.recommendation.idempotency_key);
    if (priorKey !== undefined) throw this.error("PERSONAL_RECOMMENDATION_IDEMPOTENCY_CONFLICT");
    this.insertRecommendation(input);
    return {
      recommendation_id: input.recommendation.id,
      canonical_digest: input.canonicalDigest,
      evidence_digest: input.evidenceDigest,
    };
  }

  private requireEvidence(recommendation: RecommendationV1): void {
    const linked = this.database.prepare(
      "SELECT evidence_id,source_id,evidence_digest FROM personal_context_evidence WHERE context_id=?",
    ).all(recommendation.payload.context_id).map(persistenceRow);
    const changed = recommendation.evidence.some(item => !linked.some(row => (
      row["evidence_id"] === item.evidence_id
      && row["source_id"] === item.source_id
      && row["evidence_digest"] === item.digest
    )));
    const foreignCitation = recommendation.payload.citations.some(citation => (
      !recommendation.evidence.some(item => item.evidence_id === citation)
    ));
    if (changed || foreignCitation) throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT");
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

  transition(input: RecommendationActionTransition): void {
    if (!isPersistenceTime(input.occurred_at)) throw this.error("PERSONAL_TIME_INVALID");
    if (!Number.isInteger(input.rank) || input.rank < 1 || !isActionState(input.state)) {
      throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    }
    this.database.transaction(() => this.insertTransition(input))();
  }

  private insertTransition(input: RecommendationActionTransition): void {
    const value = this.database.prepare(
      `SELECT r.evidence_digest,r.expires_at AS recommendation_expires_at,
              c.expires_at AS context_expires_at,
              (SELECT state FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
               ORDER BY event_sequence DESC LIMIT 1) AS state,
              (SELECT occurred_at FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
               ORDER BY event_sequence DESC LIMIT 1) AS occurred_at
       FROM personal_recommendation_actions a
       JOIN personal_recommendations r ON r.recommendation_id=a.recommendation_id
       JOIN personal_context_snapshots c ON c.context_id=r.context_id
       WHERE a.recommendation_id=? AND a.rank=?`,
    ).get(input.recommendation_id, input.rank);
    if (value === undefined) throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    const action = persistenceRow(value);
    if (action["evidence_digest"] !== input.evidence_digest) {
      throw this.error("PERSONAL_RECOMMENDATION_EVIDENCE_CONFLICT");
    }
    if (action["state"] !== "pending" || input.occurred_at < persistenceText(action["occurred_at"])) {
      throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    }
    const deadline = [
      persistenceText(action["recommendation_expires_at"]),
      persistenceText(action["context_expires_at"]),
    ].sort()[0];
    if (deadline === undefined) throw new TypeError("recommendation deadline required");
    if (input.state === "expired") {
      if (input.occurred_at < deadline) throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    } else if (input.occurred_at >= deadline) {
      throw this.error("PERSONAL_RECOMMENDATION_EXPIRED");
    }
    this.database.prepare(
      "INSERT INTO personal_recommendation_action_events(recommendation_id,rank,state,evidence_digest,occurred_at) VALUES(?,?,?,?,?)",
    ).run(input.recommendation_id, input.rank, input.state, input.evidence_digest, input.occurred_at);
    recordPersonalAudit(this.database, {
      event: "action_state_recorded",
      subject: `${input.recommendation_id}:${input.rank}:${input.state}`,
      digest: input.evidence_digest,
      correlation: input.recommendation_id,
      causation: null,
      occurredAt: input.occurred_at,
    });
  }

}
