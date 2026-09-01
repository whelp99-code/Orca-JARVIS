import type Database from "better-sqlite3";
import { PersonalContextEvidenceResolver } from "./personal-context-evidence.js";
import { parseContextPersistenceInput } from "./personal-context-input.js";
import { bindContextMemoryProjection } from "./memory-projection-bindings.js";
import type {
  ContextPersistenceInput,
  ParsedContextPersistenceInput,
  StoredContext,
} from "./personal-context-types.js";
import type { Sha256Digest } from "./personal-contracts.js";
import {
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
} from "./personal-validation.js";
import {
  type PersistenceErrorFactory,
  type PersistenceRow,
  isPersistenceTime,
  persistenceHash,
  persistenceNumber,
  persistenceRow,
  recordPersonalAudit,
  requireAdvisory,
} from "./personal-persistence-values.js";

export type { ContextMemoryEvidenceBinding, ContextPersistenceInput, StoredContext } from "./personal-context-types.js";

export class PersonalContextStore {
  private readonly evidence: PersonalContextEvidenceResolver;

  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {
    this.evidence = new PersonalContextEvidenceResolver(database, error);
  }

  persist(value: ContextPersistenceInput, now: string): StoredContext {
    if (!isPersistenceTime(now)) throw this.error("PERSONAL_TIME_INVALID");
    const input = parseContextPersistenceInput(value, this.error);
    requireAdvisory(input.context.authority, this.error, "PERSONAL_CONTEXT_INVALID");
    const canonicalDigest = canonicalPersonalContractHash(input.context);
    const persistenceDigest = persistenceHash({
      canonical_digest: canonicalDigest,
      memory_evidence: input.memory_evidence,
    });
    const envelope = canonicalPersonalContractJson(input.context);
    return this.database.transaction(() => this.insert({
      canonicalDigest,
      envelope,
      input,
      now,
      persistenceDigest,
    }))();
  }

  private insert(value: {
    readonly canonicalDigest: Sha256Digest;
    readonly envelope: string;
    readonly input: ParsedContextPersistenceInput;
    readonly now: string;
    readonly persistenceDigest: Sha256Digest;
  }): StoredContext {
    const context = value.input.context;
    const priorIdentity = this.database.prepare(
      `SELECT idempotency_key,canonical_digest,persistence_digest,version,observation_count,evidence_count
       FROM personal_context_snapshots WHERE context_id=?`,
    ).get(context.id);
    if (priorIdentity !== undefined) return this.replay(value, persistenceRow(priorIdentity));
    const priorKey = this.database.prepare(
      "SELECT context_id FROM personal_context_snapshots WHERE idempotency_key=?",
    ).get(context.idempotency_key);
    if (priorKey !== undefined) throw this.error("PERSONAL_CONTEXT_IDEMPOTENCY_CONFLICT");
    if (Date.parse(context.expires_at) <= Date.parse(value.now)) throw this.error("PERSONAL_CONTEXT_EXPIRED");
    const evidence = this.evidence.resolve(value.input, value.now);
    const versionValue = this.database.prepare(
      "SELECT COALESCE(MAX(version),0)+1 AS version FROM personal_context_snapshots WHERE purpose=? AND declared_query=?",
    ).get(context.payload.purpose, context.payload.query);
    const version = persistenceNumber(persistenceRow(versionValue)["version"]);
    this.insertSnapshot(value, version, evidence.length);
    evidence.forEach((item, position) => {
      this.database.prepare(
        `INSERT INTO personal_context_evidence(
           context_id,position,evidence_id,source_id,evidence_kind,evidence_digest,
           freshness_state,fresh_until,observed_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        context.id,
        position,
        item.evidence.evidence_id,
        item.evidence.source_id,
        item.evidence.kind,
        item.evidence.digest,
        item.freshness_state,
        item.fresh_until,
        item.evidence.observed_at,
      );
    });
    context.payload.included_observation_refs.forEach((reference, position) => {
      const observation = this.database.prepare(
        "SELECT canonical_digest FROM personal_observations WHERE observation_id=?",
      ).get(reference);
      if (observation === undefined) throw this.error("PERSONAL_CONTEXT_INVALID");
      this.database.prepare(
        "INSERT INTO personal_context_observations(context_id,position,observation_id,observation_digest) VALUES(?,?,?,?)",
      ).run(context.id, position, reference, persistenceRow(observation)["canonical_digest"]);
    });
    value.input.memory_evidence.forEach(item => {
      this.database.prepare(
        `INSERT INTO personal_context_memory_evidence(
           context_id,memory_ref,evidence_id,source_id,evidence_digest,observed_at,fresh_until
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        context.id,
        item.memory_ref,
        item.evidence_id,
        item.source_id,
        item.digest,
        item.observed_at,
        item.fresh_until,
      );
    });
    bindContextMemoryProjection(this.database, context.id,
      value.input.memory_evidence.map(item => item.memory_ref), new Date(value.now));
    recordPersonalAudit(this.database, {
      event: "context_recorded",
      subject: context.id,
      digest: value.canonicalDigest,
      correlation: context.correlation_id,
      causation: context.causation_id,
      occurredAt: value.now,
    });
    return {
      context_id: context.id,
      canonical_digest: value.canonicalDigest,
      version,
      observation_count: context.payload.included_observation_refs.length,
      evidence_count: evidence.length,
    };
  }

  private insertSnapshot(
    value: {
      readonly canonicalDigest: Sha256Digest;
      readonly envelope: string;
      readonly input: ParsedContextPersistenceInput;
      readonly persistenceDigest: Sha256Digest;
    },
    version: number,
    evidenceCount: number,
  ): void {
    const context = value.input.context;
    this.database.prepare(
      `INSERT INTO personal_context_snapshots(
         context_id,idempotency_key,purpose,declared_query,version,canonical_digest,persistence_digest,
         canonical_envelope_json,payload_state,freshness_state,fresh_until,item_count,observation_count,
         evidence_count,memory_count,max_items,max_excerpt_bytes,max_total_bytes,conflict_count,omission_count,
         observed_at,valid_at,expires_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      context.id,
      context.idempotency_key,
      context.payload.purpose,
      context.payload.query,
      version,
      value.canonicalDigest,
      value.persistenceDigest,
      value.envelope,
      context.payload.state,
      context.freshness.state,
      context.freshness.fresh_until,
      this.itemCount(value.input),
      context.payload.included_observation_refs.length,
      evidenceCount,
      context.payload.included_memory_refs.length,
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
  }

  private replay(
    value: {
      readonly canonicalDigest: Sha256Digest;
      readonly input: ParsedContextPersistenceInput;
      readonly persistenceDigest: Sha256Digest;
    },
    prior: PersistenceRow,
  ): StoredContext {
    if (prior["canonical_digest"] !== value.canonicalDigest
      || prior["persistence_digest"] !== value.persistenceDigest
      || prior["idempotency_key"] !== value.input.context.idempotency_key) {
      throw this.error("PERSONAL_CONTEXT_IDEMPOTENCY_CONFLICT");
    }
    return {
      context_id: value.input.context.id,
      canonical_digest: value.canonicalDigest,
      version: persistenceNumber(prior["version"]),
      observation_count: persistenceNumber(prior["observation_count"]),
      evidence_count: persistenceNumber(prior["evidence_count"]),
    };
  }

  private itemCount(input: ParsedContextPersistenceInput): number {
    const payload = input.context.payload;
    return payload.included_observation_refs.length
      + payload.included_memory_refs.length
      + payload.excluded_refs.length
      + payload.pending_authority_refs.length
      + payload.conflicts.length
      + payload.omissions.length;
  }
}
