import { controlValueDigest as hash } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import { correctionCompactionProof } from "./memory-correction-compaction-proof.js";
import { invalidCorrectionControl as invalid, type CorrectionControlRow } from "./memory-correction-control-binding.js";
import { verifyMemoryDispositionProof } from "./memory-disposition-proof.js";

export function correctionTerminalProof(authority: AuthorityDb, record: CorrectionControlRow, now: Date) {
  const stored = authority.db.prepare("SELECT * FROM memory_correction_proofs WHERE correction_id=?")
    .get(record.correction_id) as Record<string, unknown> | undefined;
  if (record.state !== "settled" || !stored || !Number.isFinite(now.getTime())) return invalid();
  if (record.correction_id !== `memcorr:v1:${record.request_digest.slice(7)}`) return invalid();
  const preparation = authority.db.prepare("SELECT * FROM memory_effect_preparations WHERE lane_id=?")
    .get(record.lane_id) as Record<string, unknown> | undefined;
  if (!preparation || preparation.lane !== "correction" || preparation.operation !== "correct"
    || !["approved", "consumed"].includes(String(preparation.state))) return invalid();
  for (const name of ["candidate_id", "provider_instance_id", "request_id", "request_digest", "target_manifest_digest",
    "scope_digest", "payload_digest", "spool_digest", "expires_at"] as const) {
    if (preparation[name] !== record[name]) return invalid();
  }
  const verified = new Date(String(stored.verified_at));
  const proof = verifyMemoryDispositionProof(authority, JSON.parse(String(stored.proof_json)),
    { ...record, operation: "correct" }, verified);
  const purge = correctionCompactionProof(authority, record, now);
  if (purge === undefined || purge.digest !== record.purge_receipt_digest
    || stored.purge_receipt_digest !== purge.digest || stored.settled_at !== record.settled_at
    || stored.proof_digest !== proof.proof_digest || record.provider_proof_digest !== proof.proof_digest
    || stored.proof_id !== proof.proof_id || stored.provider_release_sha !== proof.provider_release_sha
    || stored.result_generation_id !== proof.result_generation_id
    || stored.surface_manifest_digest !== proof.surface_manifest_digest
    || stored.artifact_manifest_digest !== proof.artifact_manifest_digest
    || !Number.isFinite(Date.parse(record.settled_at)) || verified.getTime() > Date.parse(record.settled_at)
    || Date.parse(record.settled_at) < Date.parse(purge.compacted_at)
    || Date.parse(record.settled_at) > now.getTime() || Date.parse(proof.claimed_at) < Date.parse(record.dispatched_at)) return invalid();
  const attempt = authority.db.prepare("SELECT * FROM memory_correction_attempts WHERE correction_id=?")
    .get(record.correction_id) as Record<string, unknown> | undefined;
  const invocation = hash({ correction_id: record.correction_id, dispatch_fence: 1, request_digest: record.request_digest });
  if (!attempt || record.dispatch_fence !== 1 || attempt.dispatch_fence !== 1
    || attempt.invocation_digest !== invocation || attempt.attempt_id !== `memcorr-attempt:v1:${invocation.slice(7)}`
    || attempt.dispatched_at !== record.dispatched_at || !["accepted", "uncertain"].includes(String(attempt.outcome))) return invalid();
  const events = authority.db.prepare("SELECT * FROM memory_correction_events WHERE correction_id=? ORDER BY sequence")
    .all(record.correction_id) as Record<string, unknown>[];
  for (const [index, event] of events.entries()) {
    const digest = hash({ correction_id: record.correction_id, sequence: event.sequence,
      event_type: event.event_type, proof_digest: event.proof_digest, created_at: event.created_at });
    if (event.sequence !== index + 1 || event.event_digest !== digest
      || event.event_id !== `memcorr-event:v1:${digest.slice(7)}`
      || !Number.isFinite(Date.parse(String(event.created_at)))
      || Date.parse(String(event.created_at)) < Date.parse(String(events[index - 1]?.created_at ?? record.created_at))
      || Date.parse(String(event.created_at)) > now.getTime()) return invalid();
  }
  const dispatched = events.find(event => event.event_type === "dispatching");
  if (!dispatched || dispatched.created_at !== record.dispatched_at || dispatched.proof_digest !== null
    || events[0]?.event_type !== "approved" || events[0].created_at !== record.created_at) return invalid();
  const [observed, purged, settled] = events.slice(-3);
  if (!observed || !purged || !settled || observed.event_type !== "provider_proved"
    || observed.proof_digest !== proof.proof_digest || observed.created_at !== stored.verified_at
    || purged.event_type !== "purged" || settled.event_type !== "settled"
    || purged.proof_digest !== purge.digest || settled.proof_digest !== purge.digest
    || purged.created_at !== record.settled_at || settled.created_at !== record.settled_at) return invalid();
  return { correction_id: record.correction_id, request_digest: record.request_digest,
    proof_digest: proof.proof_digest, purge_receipt_digest: purge.digest,
    terminal_event_id: String(settled.event_id) };
}
