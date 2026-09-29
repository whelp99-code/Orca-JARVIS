import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export type MemoryCorrectionState =
  | "approved" | "queued" | "dispatching" | "reconciling"
  | "provider_proved" | "settled" | "conflict";
export type MemoryCorrectionRecord = {
  readonly correction_id: string;
  readonly lane_id: string;
  readonly candidate_id: string;
  readonly control_request_id: string;
  readonly control_receipt_id: string;
  readonly provider_instance_id: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly envelope_digest: string;
  readonly idempotency_key: string;
  readonly delegation_id: string;
  readonly delegation_digest: string;
  readonly target_manifest_digest: string;
  readonly scope_digest: string;
  readonly payload_digest: string;
  readonly tombstone_sequence: number;
  readonly tombstone_set_root: string;
  readonly spool_locator: string | null;
  readonly spool_digest: string;
  readonly state: MemoryCorrectionState;
  readonly dispatch_fence: number;
  readonly provider_proof_digest: string | null;
  readonly purge_receipt_digest: string | null;
  readonly failure_code: string | null;
  readonly expires_at: string;
  readonly updated_at: string;
};

export class MemoryCorrectionStore {
  constructor(private readonly authority: AuthorityDb) {}

  get(correctionId: string): MemoryCorrectionRecord | undefined {
    return this.authority.db.prepare(
      "SELECT * FROM memory_correction_requests WHERE correction_id=?",
    ).get(correctionId) as MemoryCorrectionRecord | undefined;
  }

  getByControl(controlRequestId: string): MemoryCorrectionRecord | undefined {
    return this.authority.db.prepare(
      "SELECT * FROM memory_correction_requests WHERE control_request_id=?",
    ).get(controlRequestId) as MemoryCorrectionRecord | undefined;
  }

  insert(value: Omit<MemoryCorrectionRecord,
    "state" | "dispatch_fence" | "provider_proof_digest" | "purge_receipt_digest" | "failure_code" | "updated_at">,
  controlCommandDigest: string, now: Date): MemoryCorrectionRecord {
    const at = now.toISOString();
    const prior = this.get(value.correction_id);
    if (prior !== undefined) {
      if (prior.request_digest !== value.request_digest || prior.lane_id !== value.lane_id) {
        throw new JarvisError("MEMORY_CORRECTION_REPLAY_CONFLICT");
      }
      return prior;
    }
    this.authority.db.prepare(
      `INSERT INTO memory_correction_requests(
        correction_id,lane_id,candidate_id,control_request_id,control_receipt_id,control_command_digest,
        provider_instance_id,request_id,request_digest,envelope_digest,idempotency_key,delegation_id,
        delegation_digest,target_manifest_digest,scope_digest,payload_digest,tombstone_sequence,
        tombstone_set_root,spool_locator,spool_digest,state,dispatch_fence,expires_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved',0,?,?,?)`,
    ).run(value.correction_id, value.lane_id, value.candidate_id, value.control_request_id,
      value.control_receipt_id, controlCommandDigest, value.provider_instance_id, value.request_id,
      value.request_digest, value.envelope_digest, value.idempotency_key, value.delegation_id,
      value.delegation_digest, value.target_manifest_digest, value.scope_digest, value.payload_digest,
      value.tombstone_sequence, value.tombstone_set_root, value.spool_locator, value.spool_digest,
      value.expires_at, at, at);
    this.event(value.correction_id, "approved", now);
    this.transition(value.correction_id, "approved", "queued", now);
    this.event(value.correction_id, "suppressed", now);
    this.event(value.correction_id, "queued", now);
    return this.required(value.correction_id);
  }

  beginDispatch(correctionId: string, now: Date): MemoryCorrectionRecord {
    const at = now.toISOString();
    return this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (this.authority.db.prepare("SELECT 1 FROM memory_correction_cancellation_intents WHERE correction_id=?").get(correctionId)) {
        throw new JarvisError("MEMORY_REQUEST_CANCELLED");
      }
      if (row.state === "dispatching" || row.state === "reconciling"
        || row.state === "provider_proved" || row.state === "settled") return row;
      if (new MemoryProjectionAuthority(this.authority).isProjectionIdSuppressed(row.candidate_id)) {
        throw new JarvisError("MEMORY_CANDIDATE_SUPPRESSED");
      }
      if (row.state !== "queued" || row.dispatch_fence !== 0) {
        throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      }
      const changed = this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='dispatching',dispatch_fence=1,
         dispatched_at=?,reconcile_deadline_at=?,updated_at=?
         WHERE correction_id=? AND state='queued' AND dispatch_fence=0`,
      ).run(at, new Date(now.getTime() + 600_000).toISOString(), at, correctionId);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_CORRECTION_DISPATCH_RACE");
      const invocationDigest = hash({ correction_id: correctionId, dispatch_fence: 1,
        request_digest: row.request_digest });
      this.authority.db.prepare(
        `INSERT INTO memory_correction_attempts(
          attempt_id,correction_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at
         ) VALUES(?,?,1,?,'dispatching',?,?)`,
      ).run(`memcorr-attempt:v1:${invocationDigest.slice(7)}`, correctionId,
        invocationDigest, at, at);
      this.event(correctionId, "dispatching", now);
      return this.required(correctionId);
    }).immediate();
  }

  accepted(correctionId: string, acceptance: unknown, queueLocator: string, now: Date): void {
    const at = now.toISOString();
    const acceptanceDigest = hash(acceptance);
    this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (row.state === "reconciling") return;
      if (row.state !== "dispatching") throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      this.authority.db.prepare(
        `UPDATE memory_correction_attempts SET outcome='accepted',acceptance_digest=?,
         queue_locator_digest=?,outcome_code='PROVIDER_ACCEPTED',completed_at=?
         WHERE correction_id=? AND outcome='dispatching'`,
      ).run(acceptanceDigest, hash({ queue_locator: queueLocator }), at, correctionId);
      this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='reconciling',spool_locator=NULL,
         updated_at=? WHERE correction_id=? AND state='dispatching'`,
      ).run(at, correctionId);
      this.event(correctionId, "accepted", now, acceptanceDigest);
    }).immediate();
  }

  uncertain(correctionId: string, code: string, now: Date): void {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (row.state === "reconciling") return;
      if (row.state !== "dispatching") throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      this.authority.db.prepare(
        `UPDATE memory_correction_attempts SET outcome='uncertain',outcome_code=?,completed_at=?
         WHERE correction_id=? AND outcome='dispatching'`,
      ).run(code, at, correctionId);
      this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='reconciling',failure_code=?,updated_at=?
         WHERE correction_id=? AND state='dispatching'`,
      ).run(code, at, correctionId);
      this.event(correctionId, "uncertain", now);
    }).immediate();
  }

  providerProved(correctionId: string, proof: {
    readonly proof_id: string; readonly proof_digest: string; readonly provider_release_sha: string;
    readonly result_generation_id: string; readonly surface_manifest_digest: string;
    readonly artifact_manifest_digest: string; readonly proof_json: string;
  }, now: Date): void {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (row.state === "provider_proved" || row.state === "settled") return;
      if (row.state !== "reconciling") throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      this.authority.db.prepare(
        `INSERT INTO memory_correction_proofs(
          correction_id,proof_id,proof_digest,provider_release_sha,result_generation_id,
          surface_manifest_digest,artifact_manifest_digest,proof_json,verified_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(correctionId, proof.proof_id, proof.proof_digest, proof.provider_release_sha,
        proof.result_generation_id, proof.surface_manifest_digest, proof.artifact_manifest_digest,
        proof.proof_json, at);
      this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='provider_proved',provider_proof_digest=?,
         surface_manifest_digest=?,spool_locator=NULL,failure_code=NULL,updated_at=? WHERE correction_id=? AND state='reconciling'`,
      ).run(proof.proof_digest, proof.surface_manifest_digest, at, correctionId);
      this.event(correctionId, "provider_proved", now, proof.proof_digest);
    }).immediate();
  }

  /** Ends a lane the provider decided against before any effect. Records no proof and no purge. */
  refuse(correctionId: string, code: string, now: Date): MemoryCorrectionRecord {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (row.state === "conflict") return;
      if (row.state !== "reconciling") throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='conflict',failure_code=?,spool_locator=NULL,
         updated_at=? WHERE correction_id=? AND state='reconciling'`,
      ).run(code, at, correctionId);
      this.event(correctionId, "conflict", now);
    }).immediate();
    return this.required(correctionId);
  }

  settle(correctionId: string, purgeReceiptDigest: string, now: Date): MemoryCorrectionRecord {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      const row = this.required(correctionId);
      if (row.state === "settled") return;
      if (row.state !== "provider_proved") throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
      this.authority.db.prepare(
        `UPDATE memory_correction_proofs SET purge_receipt_digest=?,settled_at=?
         WHERE correction_id=? AND purge_receipt_digest IS NULL`,
      ).run(purgeReceiptDigest, at, correctionId);
      this.authority.db.prepare(
        `UPDATE memory_correction_requests SET state='settled',purge_receipt_digest=?,settled_at=?,
         updated_at=? WHERE correction_id=? AND state='provider_proved'`,
      ).run(purgeReceiptDigest, at, at, correctionId);
      this.event(correctionId, "purged", now, purgeReceiptDigest);
      this.event(correctionId, "settled", now, purgeReceiptDigest);
    }).immediate();
    return this.required(correctionId);
  }

  private transition(id: string, prior: MemoryCorrectionState, next: MemoryCorrectionState, now: Date): void {
    const changed = this.authority.db.prepare(
      "UPDATE memory_correction_requests SET state=?,updated_at=? WHERE correction_id=? AND state=?",
    ).run(next, now.toISOString(), id, prior);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_CORRECTION_TRANSITION_INVALID");
  }

  private event(id: string, type: string, now: Date, proofDigest?: string): void {
    const sequence = Number((this.authority.db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM memory_correction_events WHERE correction_id=?",
    ).get(id) as { readonly sequence: number }).sequence);
    const eventDigest = hash({ correction_id: id, sequence, event_type: type,
      proof_digest: proofDigest ?? null, created_at: now.toISOString() });
    this.authority.db.prepare(
      `INSERT INTO memory_correction_events(
        event_id,correction_id,sequence,event_type,event_digest,proof_digest,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(`memcorr-event:v1:${eventDigest.slice(7)}`, id, sequence, type,
      eventDigest, proofDigest ?? null, now.toISOString());
  }

  private required(id: string): MemoryCorrectionRecord {
    const row = this.get(id);
    if (row === undefined) throw new JarvisError("MEMORY_CORRECTION_NOT_FOUND");
    return row;
  }
}
