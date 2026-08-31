import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export type MemoryDeletionState = "requested" | "approved" | "suppressed" | "queued" | "applying" | "reconciling" | "provider_proved" | "settled";
export type MemoryDeletionRecord = {
  readonly deletion_id: string; readonly lane_id: string | null; readonly correlation_id: string;
  readonly idempotency_key: string; readonly provider_instance_id: string | null;
  readonly keyed_subject_digest: string; readonly scope_digest: string;
  readonly target_manifest_digest: string; readonly payload_digest: string;
  readonly state: MemoryDeletionState; readonly control_request_id: string | null;
  readonly control_receipt_id: string | null; readonly tombstone_sequence: number | null;
  readonly tombstone_set_root: string | null; readonly request_id: string | null;
  readonly request_digest: string | null; readonly envelope_digest: string | null;
  readonly provider_idempotency_key: string | null;
  readonly delegation_id: string | null; readonly delegation_digest: string | null;
  readonly spool_locator: string | null; readonly spool_digest: string | null;
  readonly dispatch_fence: number; readonly provider_proof_digest: string | null;
  readonly surface_manifest_digest: string | null; readonly purge_receipt_digest: string | null;
  readonly expires_at: string; readonly updated_at: string;
};

export class MemoryDeletionStore {
  constructor(private readonly authority: AuthorityDb) {}
  get(id: string): MemoryDeletionRecord | undefined {
    return this.authority.db.prepare("SELECT * FROM memory_deletion_requests WHERE deletion_id=?")
      .get(id) as MemoryDeletionRecord | undefined;
  }
  request(input: {
    readonly deletion_id: string; readonly correlation_id: string; readonly idempotency_key: string;
    readonly keyed_subject_digest: string; readonly scope_digest: string;
    readonly target_manifest_digest: string; readonly payload_digest: string;
    readonly spool_locator: string; readonly spool_digest: string; readonly expires_at: string;
  }, now: Date): MemoryDeletionRecord {
    const prior = this.get(input.deletion_id);
    if (prior !== undefined) {
      if (prior.idempotency_key !== input.idempotency_key || prior.payload_digest !== input.payload_digest) {
        throw new JarvisError("MEMORY_DELETION_REPLAY_CONFLICT");
      }
      return prior;
    }
    const at = now.toISOString();
    this.authority.db.prepare(
      `INSERT INTO memory_deletion_requests(
        deletion_id,correlation_id,idempotency_key,operation,keyed_subject_digest,scope_digest,
        target_manifest_digest,payload_digest,requested_by,state,spool_locator,spool_digest,
        dispatch_fence,expires_at,created_at,updated_at
       ) VALUES(?,?,?,'forget',?,?,?,?,'principal:owner','requested',?,?,0,?,?,?)`,
    ).run(input.deletion_id, input.correlation_id, input.idempotency_key,
      input.keyed_subject_digest, input.scope_digest, input.target_manifest_digest,
      input.payload_digest, input.spool_locator, input.spool_digest, input.expires_at, at, at);
    this.event(input.deletion_id, "requested", now);
    return this.required(input.deletion_id);
  }
  approve(id: string, value: {
    readonly lane_id: string; readonly provider_instance_id: string; readonly control_request_id: string;
    readonly control_receipt_id: string; readonly control_command_digest: string;
  }, now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_deletion_requests SET state='approved',lane_id=?,provider_instance_id=?,
       control_request_id=?,control_receipt_id=?,control_command_digest=?,updated_at=?
       WHERE deletion_id=? AND state='requested'`,
    ).run(value.lane_id, value.provider_instance_id, value.control_request_id,
      value.control_receipt_id, value.control_command_digest, now.toISOString(), id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
    this.event(id, "approved", now);
  }
  suppress(id: string, sequence: number, setRoot: string, now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_deletion_requests SET state='suppressed',tombstone_sequence=?,
       tombstone_set_root=?,updated_at=? WHERE deletion_id=? AND state='approved'`,
    ).run(sequence, setRoot, now.toISOString(), id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
    this.event(id, "suppressed", now);
  }
  queue(id: string, value: {
    readonly request_id: string; readonly request_digest: string; readonly envelope_digest: string;
    readonly provider_idempotency_key: string; readonly delegation_id: string;
    readonly delegation_digest: string; readonly spool_locator: string;
  }, now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_deletion_requests SET state='queued',request_id=?,request_digest=?,envelope_digest=?,
       provider_idempotency_key=?,delegation_id=?,delegation_digest=?,spool_locator=?,updated_at=?
       WHERE deletion_id=? AND state='suppressed'`,
    ).run(value.request_id, value.request_digest, value.envelope_digest,
      value.provider_idempotency_key, value.delegation_id, value.delegation_digest,
      value.spool_locator, now.toISOString(), id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
    this.event(id, "queued", now);
  }
  begin(id: string, now: Date): MemoryDeletionRecord {
    return this.authority.db.transaction(() => {
      const row = this.required(id);
      if (row.state !== "queued" || row.request_digest === null) {
        if (["applying", "reconciling", "provider_proved", "settled"].includes(row.state)) return row;
        throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
      }
      const at = now.toISOString();
      const changed = this.authority.db.prepare(
        `UPDATE memory_deletion_requests SET state='applying',dispatch_fence=1,dispatched_at=?,
         reconcile_deadline_at=?,updated_at=? WHERE deletion_id=? AND state='queued' AND dispatch_fence=0`,
      ).run(at, new Date(now.getTime() + 600_000).toISOString(), at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_DISPATCH_RACE");
      const invocation = hash({ deletion_id: id, request_digest: row.request_digest, dispatch_fence: 1 });
      this.authority.db.prepare(
        `INSERT INTO memory_deletion_attempts(
          attempt_id,deletion_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at
         ) VALUES(?,?,1,?,'dispatching',?,?)`,
      ).run(`memdel-attempt:v1:${invocation.slice(7)}`, id, invocation, at, at);
      this.event(id, "applying", now);
      return this.required(id);
    }).immediate();
  }
  accepted(id: string, acceptance: unknown, queueLocator: string, now: Date): void {
    const at = now.toISOString(); const acceptanceDigest = hash(acceptance);
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `UPDATE memory_deletion_attempts SET outcome='accepted',acceptance_digest=?,
         queue_locator_digest=?,outcome_code='PROVIDER_ACCEPTED',completed_at=?
         WHERE deletion_id=? AND outcome='dispatching'`,
      ).run(acceptanceDigest, hash({ queue_locator: queueLocator }), at, id);
      const changed = this.authority.db.prepare(
        `UPDATE memory_deletion_requests SET state='reconciling',spool_locator=NULL,
         failure_code=NULL,updated_at=? WHERE deletion_id=? AND state='applying'`,
      ).run(at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
      this.event(id, "accepted", now, acceptanceDigest);
      this.event(id, "reconciling", now);
    }).immediate();
  }
  uncertain(id: string, code: string, now: Date): void {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `UPDATE memory_deletion_attempts SET outcome='uncertain',outcome_code=?,completed_at=?
         WHERE deletion_id=? AND outcome='dispatching'`,
      ).run(code, at, id);
      const changed = this.authority.db.prepare(
        `UPDATE memory_deletion_requests SET state='reconciling',failure_code=?,updated_at=?
         WHERE deletion_id=? AND state='applying'`,
      ).run(code, at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
      this.event(id, "uncertain", now);
      this.event(id, "reconciling", now);
    }).immediate();
  }
  proved(id: string, proof: {
    readonly proof_id: string; readonly proof_digest: string; readonly provider_release_sha: string;
    readonly result_generation_id: string; readonly surface_manifest_digest: string;
    readonly proof_json: string;
  }, now: Date): void {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `INSERT INTO memory_deletion_proofs(
          deletion_id,proof_id,proof_digest,provider_release_sha,result_generation_id,
          surface_manifest_digest,proof_json,verified_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(id, proof.proof_id, proof.proof_digest, proof.provider_release_sha,
        proof.result_generation_id, proof.surface_manifest_digest, proof.proof_json, at);
      const changed = this.authority.db.prepare(
        `UPDATE memory_deletion_requests SET state='provider_proved',provider_proof_digest=?,
         surface_manifest_digest=?,failure_code=NULL,updated_at=?
         WHERE deletion_id=? AND state='reconciling'`,
      ).run(proof.proof_digest, proof.surface_manifest_digest, at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
      this.event(id, "provider_proved", now, proof.proof_digest);
    }).immediate();
  }
  settle(id: string, purgeReceipt: string, now: Date): MemoryDeletionRecord {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        "UPDATE memory_deletion_proofs SET purge_receipt_digest=?,settled_at=? WHERE deletion_id=?",
      ).run(purgeReceipt, at, id);
      const changed = this.authority.db.prepare(
        `UPDATE memory_deletion_requests SET state='settled',purge_receipt_digest=?,settled_at=?,
         updated_at=? WHERE deletion_id=? AND state='provider_proved'`,
      ).run(purgeReceipt, at, at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DELETION_TRANSITION_INVALID");
      this.event(id, "purged", now, purgeReceipt); this.event(id, "settled", now, purgeReceipt);
    }).immediate();
    return this.required(id);
  }
  private event(id: string, type: string, now: Date, proof?: string): void {
    const sequence = Number((this.authority.db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM memory_deletion_events WHERE deletion_id=?",
    ).get(id) as { readonly sequence: number }).sequence);
    const digest = hash({ deletion_id: id, sequence, event_type: type,
      proof_digest: proof ?? null, created_at: now.toISOString() });
    this.authority.db.prepare(
      `INSERT INTO memory_deletion_events(
        event_id,deletion_id,sequence,event_type,event_digest,proof_digest,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(`memdel-event:v1:${digest.slice(7)}`, id, sequence, type,
      digest, proof ?? null, now.toISOString());
  }
  private required(id: string): MemoryDeletionRecord {
    const row = this.get(id); if (row === undefined) throw new JarvisError("MEMORY_DELETION_NOT_FOUND");
    return row;
  }
}
