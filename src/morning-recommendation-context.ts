import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import { parseContextPersistenceInput } from "./personal-context-input.js";
import { PersonalContextEvidenceResolver } from "./personal-context-evidence.js";
import { canonicalPersonalContractHash } from "./personal-validation.js";
import { persistenceHash, persistenceRow } from "./personal-persistence-values.js";
import { reconstructedContextEvidence } from "./personal-recommendation-reconstruction.js";
import type { RecommendationIdentity } from "./recommendation-identity.js";

export class MorningRecommendationSourceError extends Error {
  readonly name = "MorningRecommendationSourceError";
  constructor() { super("MORNING_RECOMMENDATION_SOURCE_INVALID"); }
}
export function invalidMorningSource(): never { throw new MorningRecommendationSourceError(); }

export function readMorningRecommendationContext(database: Database.Database, identity: RecommendationIdentity, now: string) {
  const recommendation = identity.recommendation;
  const row = persistenceRow(database.prepare("SELECT * FROM personal_context_snapshots WHERE context_id=?")
    .get(recommendation.payload.context_id));
  const json = row["canonical_envelope_json"];
  if (typeof json !== "string" || Buffer.byteLength(json) > 65_536) return invalidMorningSource();
  const bindings = database.prepare(
    `SELECT memory_ref,evidence_id,source_id,evidence_digest AS digest,observed_at,fresh_until
     FROM personal_context_memory_evidence WHERE context_id=? ORDER BY rowid`,
  ).all(recommendation.payload.context_id);
  const parsed = parseContextPersistenceInput({ context: JSON.parse(json), memory_evidence: bindings }, invalidMorningSource);
  const context = parsed.context;
  const digest = canonicalPersonalContractHash(context);
  const expected = { context_id: context.id, canonical_digest: digest, observed_at: context.observed_at,
    valid_at: context.valid_at, created_at: context.created_at, expires_at: context.expires_at,
    payload_state: context.payload.state, freshness_state: context.freshness.state, fresh_until: context.freshness.fresh_until };
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)
    || digest !== recommendation.payload.context_digest
    || row["persistence_digest"] !== persistenceHash({ canonical_digest: digest, memory_evidence: parsed.memory_evidence })
    || canonicalize(context.evidence) !== canonicalize(recommendation.evidence)
    || context.authority.authority_kind !== "none" || context.created_at > now || context.freshness.checked_at > now
    || context.created_at > recommendation.created_at || context.valid_at > context.observed_at) return invalidMorningSource();
  const resolved = new PersonalContextEvidenceResolver(database, invalidMorningSource).resolve(parsed, now);
  const rows = database.prepare(
    `SELECT evidence_id,source_id,evidence_kind AS kind,evidence_digest AS digest,observed_at,fresh_until,freshness_state
     FROM personal_context_evidence WHERE context_id=? ORDER BY position`,
  ).all(context.id).map(persistenceRow).map(row => ({ ...reconstructedContextEvidence(row), freshness_state: row["freshness_state"] }));
  const expectedEvidence = resolved.map(item => ({ ...item.evidence, fresh_until: item.fresh_until, freshness_state: item.freshness_state }));
  if (canonicalize(rows) !== canonicalize(expectedEvidence)) return invalidMorningSource();
  return context;
}
