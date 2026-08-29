import type Database from "better-sqlite3";
import { isActionState, type RecommendationActionTransition } from "./personal-recommendation-types.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";
import {
  type PersistenceErrorFactory,
  isPersistenceTime,
  persistenceHash,
  persistenceRow,
  persistenceText,
  recordPersonalAudit,
} from "./personal-persistence-values.js";

export class PersonalRecommendationActionStore {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  transition(input: RecommendationActionTransition): void {
    if (!isPersistenceTime(input.occurred_at)) throw this.error("PERSONAL_TIME_INVALID");
    if (!Number.isInteger(input.rank) || input.rank < 1 || !isActionState(input.state)) {
      throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    }
    this.database.transaction(() => this.insert(input))();
  }

  private insert(input: RecommendationActionTransition): void {
    const value = this.database.prepare(
      `SELECT r.evidence_digest,r.expires_at AS recommendation_expires_at,
              c.expires_at AS context_expires_at,c.fresh_until AS context_fresh_until,
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
    const eventDigest = this.eventDigest(input);
    const exact = this.database.prepare(
      `SELECT evidence_digest,occurred_at FROM personal_recommendation_action_events
       WHERE recommendation_id=? AND rank=? AND state=?`,
    ).get(input.recommendation_id, input.rank, input.state);
    if (exact !== undefined) {
      const replay = persistenceRow(exact);
      if (replay["evidence_digest"] === eventDigest && replay["occurred_at"] === input.occurred_at) return;
      throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    }
    if (action["state"] !== "pending" || input.occurred_at < persistenceText(action["occurred_at"])) {
      throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    }
    const deadline = [
      persistenceText(action["recommendation_expires_at"]),
      persistenceText(action["context_expires_at"]),
      persistenceText(action["context_fresh_until"]),
    ].sort()[0];
    if (deadline === undefined) throw new TypeError("recommendation deadline required");
    if (input.state === "expired") {
      if (input.occurred_at < deadline) throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
    } else if (input.occurred_at >= deadline) {
      throw this.error("PERSONAL_RECOMMENDATION_EXPIRED");
    }
    try {
      this.database.prepare(
        `INSERT INTO personal_recommendation_action_events(
           recommendation_id,rank,state,evidence_digest,occurred_at
         ) VALUES(?,?,?,?,?)`,
      ).run(input.recommendation_id, input.rank, input.state, eventDigest, input.occurred_at);
    } catch (caught) {
      if (caught instanceof Error && caught.message === "action event deadline invalid") {
        throw this.error("PERSONAL_ACTION_STATE_CONFLICT");
      }
      throw caught;
    }
    recordPersonalAudit(this.database, {
      event: "action_state_recorded",
      subject: `${input.recommendation_id}:${input.rank}:${input.state}`,
      digest: eventDigest,
      correlation: input.recommendation_id,
      causation: null,
      occurredAt: input.occurred_at,
    });
  }

  private eventDigest(input: RecommendationActionTransition): string {
    if (input.state !== "superseded") {
      if (input.replacement_recommendation_id !== undefined || input.replacement_context_digest !== undefined
        || input.replacement_evidence_digest !== undefined || input.replacement_identity_digest !== undefined) {
        throw this.error("PERSONAL_ACTION_SUPERSESSION_CONFLICT");
      }
      return input.evidence_digest;
    }
    if (input.replacement_recommendation_id === undefined || input.replacement_context_digest === undefined
      || input.replacement_evidence_digest === undefined || input.replacement_identity_digest === undefined
      || input.replacement_recommendation_id === input.recommendation_id) {
      throw this.error("PERSONAL_ACTION_SUPERSESSION_CONFLICT");
    }
    const replacement = this.database.prepare(
      `SELECT r.context_digest,r.canonical_digest,r.evidence_digest,r.canonical_envelope_json,
              r.expires_at,c.expires_at AS context_expires_at,c.fresh_until,
              (SELECT COUNT(*) FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=r.recommendation_id
                 AND e.state IN ('rejected','expired','superseded','dismissed','snoozed')) AS terminal_count
       FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
       WHERE r.recommendation_id=?`,
    ).get(input.replacement_recommendation_id);
    if (replacement === undefined) throw this.error("PERSONAL_ACTION_SUPERSESSION_CONFLICT");
    const row = persistenceRow(replacement);
    const deadline = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"]),
      persistenceText(row["fresh_until"])].sort()[0];
    if (deadline === undefined || input.occurred_at >= deadline || Number(row["terminal_count"]) !== 0
      || row["context_digest"] !== input.replacement_context_digest
      || row["evidence_digest"] !== input.replacement_evidence_digest
      || storedRecommendationIdentity(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]).identity_digest
        !== input.replacement_identity_digest) {
      throw this.error("PERSONAL_ACTION_SUPERSESSION_CONFLICT");
    }
    return persistenceHash({
      evidence_digest: input.evidence_digest,
      replacement_context_digest: input.replacement_context_digest,
      replacement_evidence_digest: input.replacement_evidence_digest,
      replacement_identity_digest: input.replacement_identity_digest,
      replacement_recommendation_id: input.replacement_recommendation_id,
    });
  }
}
