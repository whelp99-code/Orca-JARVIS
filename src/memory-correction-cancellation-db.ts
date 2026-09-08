import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { parseCorrectionCancellationSource, type CorrectionCancellationSource } from "./memory-correction-cancellation-intent.js";
import { MemoryCorrectionStore, type MemoryCorrectionRecord } from "./memory-correction-store.js";
import { requireMemoryEffectWriteRequest, type MemoryEffectWriteRequestV2 } from "./second-brain-effect-v2.js";

const INVALID = "MEMORY_CANCELLATION_DB_BINDING_INVALID";
export function cancellationDatabaseKeys(authority: AuthorityDb, at: string, historical = false): Map<string, string> {
  const rows = authority.db.prepare(`SELECT key_id,public_key_pem FROM memory_effect_delegation_keys
    WHERE principal_id='principal:owner' AND algorithm='Ed25519' AND valid_from<=? AND valid_until>?
      AND (?=1 OR state='active') ORDER BY key_id`).all(at, at, Number(historical)) as Array<{ key_id: string; public_key_pem: string }>;
  return new Map(rows.map(row => [row.key_id, row.public_key_pem]));
}

export function requireCancellationDatabaseBinding(authority: AuthorityDb, correctionId: string,
  source: CorrectionCancellationSource): MemoryCorrectionRecord {
  const row = new MemoryCorrectionStore(authority).get(correctionId);
  if (!row) throw new JarvisError(INVALID);
  const d = source.original_delegation;
  const expected = { provider_instance_id: source.provider_instance_id, request_id: d.request_id,
    request_digest: d.request_digest, envelope_digest: source.original_envelope_digest,
    idempotency_key: source.original_idempotency_key, lane_id: d.lane_id, delegation_id: d.delegation_id,
    delegation_digest: d.delegation_digest, target_manifest_digest: d.target_manifest_digest,
    scope_digest: d.scope_digest, payload_digest: d.payload_digest,
    tombstone_sequence: source.tombstone.sequence, tombstone_set_root: source.tombstone.set_root };
  for (const [key, value] of Object.entries(expected)) if (Reflect.get(row, key) !== value) throw new JarvisError(INVALID);
  if (row.correction_id !== `memcorr:v1:${d.request_digest.slice(7)}`) throw new JarvisError(INVALID);
  const preparation = authority.db.prepare("SELECT * FROM memory_effect_preparations WHERE lane_id=?").get(row.lane_id) as Record<string, unknown> | undefined;
  if (!preparation || preparation.state !== "approved" || preparation.lane !== "correction" || preparation.operation !== "correct"
    || preparation.candidate_id !== row.candidate_id || preparation.spool_digest !== row.spool_digest) throw new JarvisError(INVALID);
  const aliases: Record<string, string> = { tombstone_sequence: "request_tombstone_sequence",
    tombstone_set_root: "request_tombstone_set_root", idempotency_key: "provider_idempotency_key" };
  for (const [key, value] of Object.entries(expected)) if (preparation[aliases[key] ?? key] !== value) throw new JarvisError(INVALID);
  if (preparation.provider_tombstone_sequence !== source.tombstone.sequence - 1
    || preparation.provider_tombstone_set_root !== source.tombstone.previous_root) throw new JarvisError(INVALID);
  const tomb = authority.db.prepare("SELECT * FROM memory_tombstone_chain WHERE sequence=?").get(source.tombstone.sequence) as Record<string, unknown> | undefined;
  if (!tomb || canonicalize(Object.fromEntries(Object.keys(source.tombstone).map(key => [key, tomb[key]]))) !== canonicalize(source.tombstone)) throw new JarvisError(INVALID);
  const link = authority.db.prepare("SELECT request_digest,delegation_digest FROM memory_tombstone_delegation_links WHERE sequence=?")
    .get(source.tombstone.sequence) as { request_digest: string; delegation_digest: string } | undefined;
  if (link?.request_digest !== row.request_digest || link.delegation_digest !== row.delegation_digest) throw new JarvisError(INVALID);
  return row;
}

/** Called inside the same materialization transaction; stores no replacement body. */
export function captureCorrectionCancellationSource(authority: AuthorityDb, correctionId: string, original: MemoryEffectWriteRequestV2): void {
  authority.db.transaction(() => {
    const request = requireMemoryEffectWriteRequest(original, { now: new Date(original.delegation.not_before),
      expectedProvider: original.provider_instance_id,
      delegationKeys: cancellationDatabaseKeys(authority, original.delegation.not_before, true) });
    if (request.operation !== "correct" || request.targets.length !== 1 || request.tombstone_chain_delta.length !== 1) throw new JarvisError(INVALID);
    const source = parseCorrectionCancellationSource({ provider_instance_id: request.provider_instance_id,
      original_envelope_digest: request.envelope_digest, original_idempotency_key: request.idempotency_key,
      original_delegation: request.delegation, target: request.targets[0], scope: request.scope, tombstone: request.tombstone_chain_delta[0] });
    const row = requireCancellationDatabaseBinding(authority, correctionId, source);
    if (row.state !== "queued" || row.dispatch_fence !== 0) throw new JarvisError("MEMORY_CANCELLATION_UNSENT_UNPROVED");
    const encoded = canonicalize(source);
    const prior = authority.db.prepare("SELECT source_json FROM memory_correction_cancellation_sources WHERE correction_id=?")
      .get(correctionId) as { source_json: string } | undefined;
    if (prior) { if (prior.source_json !== encoded) throw new JarvisError(INVALID); return; }
    authority.db.prepare("INSERT INTO memory_correction_cancellation_sources VALUES(?,?)").run(correctionId, encoded);
  }).immediate();
}

export function requireUnsentCancellationEvidence(authority: AuthorityDb, row: MemoryCorrectionRecord, now: Date): string {
  const cursor = authority.db.prepare("SELECT * FROM memory_effect_dispatch_cursor WHERE singleton_id=1").get() as
    { active_lane_id: string | null; accepted_through_sequence: number } | undefined;
  if (row.state !== "queued" || row.dispatch_fence !== 0 || row.provider_proof_digest !== null || row.purge_receipt_digest !== null
    || !cursor || cursor.active_lane_id === row.lane_id || cursor.accepted_through_sequence >= row.tombstone_sequence
    || authority.db.prepare("SELECT 1 FROM memory_correction_attempts WHERE correction_id=?").get(row.correction_id)) {
    throw new JarvisError("MEMORY_CANCELLATION_UNSENT_UNPROVED");
  }
  const readiness = authority.db.prepare("SELECT rebuild_state FROM memory_projection_authority WHERE singleton_id=1").get() as { rebuild_state: string } | undefined;
  if (readiness?.rebuild_state !== "ready") throw new JarvisError("MEMORY_CANCELLATION_SUPPRESSION_UNPROVED");
  const event = authority.db.prepare(`SELECT e.sequence,e.event_digest,e.projection_count,e.created_at
    FROM memory_projection_suppressions p JOIN memory_suppression_events e ON e.sequence=p.sequence
    WHERE p.projection_id=? ORDER BY e.sequence LIMIT 1`).get(row.candidate_id) as
    { sequence: number; event_digest: string; projection_count: number; created_at: string } | undefined;
  if (!event || !Number.isFinite(Date.parse(event.created_at)) || Date.parse(event.created_at) > now.getTime()) throw new JarvisError("MEMORY_CANCELLATION_SUPPRESSION_UNPROVED");
  const expected = `sha256:${createHash("sha256").update("orca-jarvis/memory-projection-suppression/v1\0")
    .update(canonicalize({ sequence: event.sequence, projection_count: event.projection_count, created_at: event.created_at })).digest("hex")}`;
  if (event.event_digest !== expected) throw new JarvisError("MEMORY_CANCELLATION_SUPPRESSION_UNPROVED");
  return expected;
}
