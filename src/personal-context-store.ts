import type Database from "better-sqlite3";
import type { ContextId, ContextSnapshotV1, Sha256Digest } from "./personal-contracts.js";
import {
  PersonalContractError,
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseContextSnapshotV1,
} from "./personal-validation.js";
import {
  type PersistenceErrorFactory,
  type PersistenceRow,
  isPersistenceRow,
  isPersistenceTime,
  persistenceNumber,
  persistenceRow,
  persistenceText,
  recordPersonalAudit,
  requireAdvisory,
} from "./personal-persistence-values.js";

export type StoredContext = {
  readonly context_id: ContextId;
  readonly canonical_digest: Sha256Digest;
  readonly version: number;
  readonly observation_count: number;
};

function contextOversize(value: unknown): boolean {
  if (!isPersistenceRow(value)) return false;
  const payload = value["payload"];
  if (!isPersistenceRow(payload)) return false;
  const lists = ["included_observation_refs", "included_memory_refs", "excluded_refs", "pending_authority_refs", "conflicts", "omissions"];
  return lists.some(key => Array.isArray(payload[key]) && payload[key].length > 32);
}

export class PersonalContextStore {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  private parse(value: unknown): ContextSnapshotV1 {
    try {
      return parseContextSnapshotV1(value);
    } catch (error) {
      if (error instanceof PersonalContractError) {
        throw this.error(contextOversize(value) ? "PERSONAL_CONTEXT_OVERSIZE" : "PERSONAL_CONTEXT_INVALID");
      }
      throw error;
    }
  }

  persist(value: unknown, now: string): StoredContext {
    if (!isPersistenceTime(now)) throw this.error("PERSONAL_TIME_INVALID");
    const context = this.parse(value);
    requireAdvisory(context.authority, this.error, "PERSONAL_CONTEXT_INVALID");
    if (Date.parse(context.expires_at) <= Date.parse(now)) throw this.error("PERSONAL_CONTEXT_EXPIRED");
    const canonicalDigest = canonicalPersonalContractHash(context);
    const envelope = canonicalPersonalContractJson(context);
    return this.database.transaction(() => this.insert(context, canonicalDigest, envelope, now))();
  }

  private insert(
    context: ContextSnapshotV1,
    canonicalDigest: Sha256Digest,
    envelope: string,
    now: string,
  ): StoredContext {
    const priorIdentity = this.database.prepare(
      "SELECT idempotency_key,canonical_digest,version,observation_count FROM personal_context_snapshots WHERE context_id=?",
    ).get(context.id);
    if (priorIdentity !== undefined) return this.replay(context, canonicalDigest, persistenceRow(priorIdentity));
    const priorKey = this.database.prepare(
      "SELECT context_id FROM personal_context_snapshots WHERE idempotency_key=?",
    ).get(context.idempotency_key);
    if (priorKey !== undefined) throw this.error("PERSONAL_CONTEXT_IDEMPOTENCY_CONFLICT");
    const observations = this.observations(context, now);
    const versionValue = this.database.prepare(
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM personal_context_snapshots WHERE purpose=? AND declared_query=?",
    ).get(context.payload.purpose, context.payload.query);
    const version = persistenceNumber(persistenceRow(versionValue)["version"]);
    const itemCount = this.itemCount(context);
    this.database.prepare(
      `INSERT INTO personal_context_snapshots(
         context_id,idempotency_key,purpose,declared_query,version,canonical_digest,canonical_envelope_json,
         item_count,observation_count,max_items,max_excerpt_bytes,max_total_bytes,conflict_count,omission_count,
         observed_at,valid_at,expires_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      context.id,
      context.idempotency_key,
      context.payload.purpose,
      context.payload.query,
      version,
      canonicalDigest,
      envelope,
      itemCount,
      observations.length,
      context.payload.budgets.max_items,
      context.payload.budgets.max_excerpt_bytes,
      context.payload.budgets.max_total_bytes,
      context.payload.conflicts.length,
      context.payload.omissions.length,
      context.observed_at,
      context.valid_at,
      context.expires_at,
      context.created_at,
    );
    observations.forEach((observation, position) => {
      this.database.prepare(
        "INSERT INTO personal_context_observations(context_id,position,observation_id,observation_digest) VALUES(?,?,?,?)",
      ).run(context.id, position, observation["observation_id"], observation["canonical_digest"]);
    });
    context.evidence.forEach((item, position) => {
      this.database.prepare(
        "INSERT INTO personal_context_evidence(context_id,position,evidence_id,source_id,evidence_kind,evidence_digest,observed_at) VALUES(?,?,?,?,?,?,?)",
      ).run(context.id, position, item.evidence_id, item.source_id, item.kind, item.digest, item.observed_at);
    });
    recordPersonalAudit(this.database, {
      event: "context_recorded",
      subject: context.id,
      digest: canonicalDigest,
      correlation: context.correlation_id,
      causation: context.causation_id,
      occurredAt: now,
    });
    return { context_id: context.id, canonical_digest: canonicalDigest, version, observation_count: observations.length };
  }

  private replay(context: ContextSnapshotV1, digest: Sha256Digest, prior: PersistenceRow): StoredContext {
    if (prior["canonical_digest"] !== digest || prior["idempotency_key"] !== context.idempotency_key) {
      throw this.error("PERSONAL_CONTEXT_INVALID");
    }
    return {
      context_id: context.id,
      canonical_digest: digest,
      version: persistenceNumber(prior["version"]),
      observation_count: persistenceNumber(prior["observation_count"]),
    };
  }

  private observations(context: ContextSnapshotV1, now: string): readonly PersistenceRow[] {
    return context.payload.included_observation_refs.map(reference => {
      const value = this.database.prepare(
        "SELECT observation_id,source_id,canonical_digest,expires_at FROM personal_observations WHERE observation_id=?",
      ).get(reference);
      if (value === undefined) throw this.error("PERSONAL_CONTEXT_INVALID");
      const stored = persistenceRow(value);
      if (Date.parse(persistenceText(stored["expires_at"])) <= Date.parse(now)) {
        throw this.error("PERSONAL_CONTEXT_SOURCE_EXPIRED");
      }
      const linked = context.evidence.some(item => (
        item.digest === stored["canonical_digest"] && item.source_id === stored["source_id"]
      ));
      if (!linked) throw this.error("PERSONAL_CONTEXT_INVALID");
      return stored;
    });
  }

  private itemCount(context: ContextSnapshotV1): number {
    return context.payload.included_observation_refs.length
      + context.payload.included_memory_refs.length
      + context.payload.excluded_refs.length
      + context.payload.pending_authority_refs.length
      + context.payload.conflicts.length
      + context.payload.omissions.length;
  }
}
