import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { canonicalize } from "./canonical.js";
import { LocalTimelineSnapshotStore } from "./local-timeline-snapshot-store.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { canonicalPersonalContractHash, parseObservationEnvelopeV1 } from "./personal-validation.js";
import type { TaskTimelineContext } from "./task-timeline.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
function uuid(value: unknown): string {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Read-only draft from an exact current cache entry. No persistence or execution authority. */
export function prepareLocalTimelineObservation(authority: Pick<AuthorityDb, "db">, taskId: string, collectionId: string,
  clock: () => Date = () => new Date()) {
  const read = new LocalTimelineSnapshotStore(authority, clock).read(taskId, collectionId);
  if (read.state !== "ready") throw new JarvisError("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  const snapshot = read.snapshot;
  const context = JSON.parse(snapshot.context_json) as TaskTimelineContext;
  const sourceId = "src:pos:v1:task-timeline:local";
  const value = { task_id: taskId, kind: context.task.kind, state: context.task.state,
    pending_approval: context.task.pending_approval, source_updated_at: snapshot.source_updated_at,
    collection_id: collectionId, collection_content_digest: snapshot.content_digest };
  const digest = `sha256:${hash(value)}`;
  // Stable replay for this collection; a replacement collection receives a distinct identity.
  const identity = { source: sourceId, taskId, collectionId, digest };
  return parseObservationEnvelopeV1({
    schema_version: 1, id: `obs:pos:v1:${sourceId}:${uuid(identity)}`,
    created_at: snapshot.completed_at, observed_at: snapshot.completed_at, valid_at: snapshot.started_at,
    source: { source_id: sourceId, source_kind: "timeline", host_id: "host:pos:linux-control-plane",
      source_version: "local-task-timeline-v1", evidence_ref: collectionId },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: snapshot.completed_at, fresh_until: new Date(Date.parse(read.expires_at) - 1).toISOString() },
    expires_at: read.expires_at, idempotency_key: `idem:pos:v1:observation:${hash(identity)}`,
    correlation_id: `corr:pos:v1:${uuid({ source: sourceId, taskId })}`, causation_id: null,
    payload: { kind: "local_task_state", subject: taskId, value, trust: "verified", sensitivity: "personal",
      cursor: null, checkpoint: null, content_digest: digest, state: "fresh" },
    policy_decision: { decision: "allow", policy_version: "local-task-observation-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence: [{ evidence_id: `evi:pos:v1:${uuid({ collectionId })}`, digest: snapshot.content_digest,
      kind: "structured_ref", source_id: sourceId, observed_at: snapshot.completed_at }], receipt: null,
  });
}


/** Revalidate persisted local material; callers must use this inside their consumption transaction. */
export function readCurrentLocalTimelineObservation(authority: Pick<AuthorityDb, "db">, observationId: string,
  clock: () => Date = () => new Date()) {
  return authority.db.transaction(() => {
    const unavailable = (): never => { throw new JarvisError("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE"); };
    const row = authority.db.prepare(`SELECT canonical_envelope_json,canonical_digest
      FROM personal_observations WHERE observation_id=?`).get(observationId) as
      { canonical_envelope_json: string; canonical_digest: string } | undefined;
    if (!row || Buffer.byteLength(row.canonical_envelope_json) > 65536) return unavailable();
    const projections = new MemoryProjectionAuthority(authority);
    if (projections.isProjectionIdSuppressed(observationId)) return unavailable();
    const stored = parseObservationEnvelopeV1(JSON.parse(row.canonical_envelope_json));
    if (stored.id !== observationId || stored.source.source_id !== "src:pos:v1:task-timeline:local"
      || stored.payload.kind !== "local_task_state"
      || canonicalize(stored) !== row.canonical_envelope_json
      || canonicalPersonalContractHash(stored) !== row.canonical_digest) return unavailable();
    const current = prepareLocalTimelineObservation(authority, stored.payload.subject, stored.source.evidence_ref, clock);
    if (canonicalize(current) !== row.canonical_envelope_json) return unavailable();
    return current;
  }).deferred();
}

/** Explicit admission only; no scheduling. Source checks and persistence share one write lock. */
export function admitLocalTimelineObservation(authority: AuthorityDb, taskId: string, collectionId: string,
  clock: () => Date = () => new Date()) {
  return authority.db.transaction(() => {
    const draft = prepareLocalTimelineObservation(authority, taskId, collectionId, clock);
    const at = clock();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || at.toISOString() < draft.created_at) {
      throw new JarvisError("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
    }
    const stored = authority.persistObservation(draft, at.toISOString());
    readCurrentLocalTimelineObservation(authority, stored.observation_id, clock);
    return stored;
  }).immediate();
}
