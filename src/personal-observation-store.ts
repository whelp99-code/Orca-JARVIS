import type Database from "better-sqlite3";
import type { ObservationEnvelopeV1, ObservationId, Sha256Digest } from "./personal-contracts.js";
import {
  PersonalContractError,
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseObservationEnvelopeV1,
} from "./personal-validation.js";
import {
  type PersistenceErrorFactory,
  isPersistenceTime,
  persistenceNumber,
  persistenceRow,
  persistenceText,
  recordPersonalAudit,
  requireAdvisory,
} from "./personal-persistence-values.js";

export type StoredObservation = {
  readonly observation_id: ObservationId;
  readonly canonical_digest: Sha256Digest;
  readonly inserted: boolean;
  readonly checkpoint_sequence: number | null;
};

export class PersonalObservationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  private parse(value: unknown): ObservationEnvelopeV1 {
    try {
      return parseObservationEnvelopeV1(value);
    } catch (error) {
      if (error instanceof PersonalContractError) throw this.error("PERSONAL_OBSERVATION_INVALID");
      throw error;
    }
  }

  persist(value: unknown, now: string): StoredObservation {
    if (!isPersistenceTime(now)) throw this.error("PERSONAL_TIME_INVALID");
    const observation = this.parse(value);
    requireAdvisory(observation.authority, this.error, "PERSONAL_OBSERVATION_INVALID");
    const canonicalDigest = canonicalPersonalContractHash(observation);
    const envelope = canonicalPersonalContractJson(observation);
    return this.database.transaction(() => this.insert(observation, canonicalDigest, envelope, now))();
  }

  private insert(
    observation: ObservationEnvelopeV1,
    canonicalDigest: Sha256Digest,
    envelope: string,
    now: string,
  ): StoredObservation {
    const priorIdentity = this.database.prepare(
      "SELECT idempotency_key,canonical_digest FROM personal_observations WHERE observation_id=?",
    ).get(observation.id);
    if (priorIdentity !== undefined) return this.replay(observation, canonicalDigest, persistenceRow(priorIdentity));
    const priorKey = this.database.prepare(
      "SELECT observation_id FROM personal_observations WHERE idempotency_key=?",
    ).get(observation.idempotency_key);
    if (priorKey !== undefined) throw this.error("PERSONAL_OBSERVATION_IDEMPOTENCY_CONFLICT");
    if (Date.parse(observation.observed_at) > Date.parse(now) || Date.parse(observation.created_at) > Date.parse(now)) {
      throw this.error("PERSONAL_OBSERVATION_FUTURE");
    }
    if (Date.parse(observation.expires_at) <= Date.parse(now)) throw this.error("PERSONAL_OBSERVATION_EXPIRED");
    const checkpointSequence = this.nextCheckpoint(observation);
    this.database.prepare(
      `INSERT INTO personal_observations(
         observation_id,idempotency_key,source_id,checkpoint,canonical_digest,content_digest,
         canonical_envelope_json,freshness_state,fresh_until,observed_at,valid_at,expires_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      observation.id,
      observation.idempotency_key,
      observation.source.source_id,
      observation.payload.checkpoint,
      canonicalDigest,
      observation.payload.content_digest,
      envelope,
      observation.freshness.state,
      observation.freshness.fresh_until,
      observation.observed_at,
      observation.valid_at,
      observation.expires_at,
      observation.created_at,
    );
    recordPersonalAudit(this.database, {
      event: "observation_recorded",
      subject: observation.id,
      digest: canonicalDigest,
      correlation: observation.correlation_id,
      causation: observation.causation_id,
      occurredAt: now,
    });
    if (checkpointSequence !== null) this.insertCheckpoint(observation, canonicalDigest, checkpointSequence, now);
    return {
      observation_id: observation.id,
      canonical_digest: canonicalDigest,
      inserted: true,
      checkpoint_sequence: checkpointSequence,
    };
  }

  private replay(
    observation: ObservationEnvelopeV1,
    digest: Sha256Digest,
    prior: Readonly<Record<string, unknown>>,
  ): StoredObservation {
    if (prior["canonical_digest"] !== digest || prior["idempotency_key"] !== observation.idempotency_key) {
      throw this.error("PERSONAL_OBSERVATION_IDENTITY_CONFLICT");
    }
    const checkpoint = this.database.prepare(
      "SELECT sequence FROM personal_source_checkpoints WHERE observation_id=?",
    ).get(observation.id);
    return {
      observation_id: observation.id,
      canonical_digest: digest,
      inserted: false,
      checkpoint_sequence: checkpoint === undefined ? null : persistenceNumber(persistenceRow(checkpoint)["sequence"]),
    };
  }

  private nextCheckpoint(observation: ObservationEnvelopeV1): number | null {
    if (observation.payload.checkpoint === null) return null;
    const latestValue = this.database.prepare(
      "SELECT sequence,checkpoint,observed_at FROM personal_source_checkpoints WHERE source_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(observation.source.source_id);
    if (latestValue === undefined) return 1;
    const latest = persistenceRow(latestValue);
    if (latest["checkpoint"] === observation.payload.checkpoint) {
      throw this.error("PERSONAL_CHECKPOINT_REPLAY_CONFLICT");
    }
    if (Date.parse(observation.observed_at) <= Date.parse(persistenceText(latest["observed_at"]))) {
      throw this.error("PERSONAL_CHECKPOINT_STALE");
    }
    return persistenceNumber(latest["sequence"]) + 1;
  }

  private insertCheckpoint(
    observation: ObservationEnvelopeV1,
    digest: Sha256Digest,
    sequence: number,
    now: string,
  ): void {
    this.database.prepare(
      "INSERT INTO personal_source_checkpoints(source_id,sequence,checkpoint,observation_id,observation_digest,observed_at,recorded_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      observation.source.source_id,
      sequence,
      observation.payload.checkpoint,
      observation.id,
      digest,
      observation.observed_at,
      now,
    );
    recordPersonalAudit(this.database, {
      event: "checkpoint_advanced",
      subject: `${observation.source.source_id}:${sequence}`,
      digest,
      correlation: observation.correlation_id,
      causation: observation.causation_id,
      occurredAt: now,
    });
  }
}
