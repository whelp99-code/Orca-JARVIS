import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export type MemoryExportState = "requested" | "approved" | "queued" | "writing" | "provider_proved" | "available" | "expired" | "invalidated";
export type MemoryExportRecord = {
  readonly export_id: string; readonly lane_id: string; readonly correlation_id: string;
  readonly idempotency_key: string; readonly provider_instance_id: string;
  readonly scope_digest: string; readonly target_manifest_digest: string; readonly payload_digest: string;
  readonly state: MemoryExportState; readonly control_request_id: string | null;
  readonly control_receipt_id: string | null; readonly tombstone_sequence: number;
  readonly tombstone_set_root: string; readonly request_id: string | null;
  readonly request_digest: string | null; readonly envelope_digest: string | null;
  readonly provider_idempotency_key: string | null; readonly delegation_id: string | null;
  readonly delegation_digest: string | null; readonly spool_locator: string | null;
  readonly spool_digest: string | null; readonly dispatch_fence: number;
  readonly provider_proof_digest: string | null; readonly export_manifest_digest: string | null;
  readonly expires_at: string; readonly artifact_expires_at: string | null;
  readonly updated_at: string;
};

export class MemoryExportStore {
  constructor(private readonly authority: AuthorityDb) {}
  get(id: string): MemoryExportRecord | undefined {
    return this.authority.db.prepare("SELECT * FROM memory_export_requests WHERE export_id=?")
      .get(id) as MemoryExportRecord | undefined;
  }
  request(input: Omit<MemoryExportRecord,
    "state" | "control_request_id" | "control_receipt_id" | "request_id" | "request_digest"
    | "envelope_digest" | "provider_idempotency_key" | "delegation_id" | "delegation_digest"
    | "dispatch_fence" | "provider_proof_digest" | "export_manifest_digest"
    | "artifact_expires_at" | "updated_at">,
  targetDigests: readonly string[], now: Date): MemoryExportRecord {
    const prior = this.get(input.export_id); if (prior !== undefined) return prior;
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `INSERT INTO memory_export_requests(
          export_id,lane_id,correlation_id,idempotency_key,provider_instance_id,operation,scope_digest,
          target_manifest_digest,payload_digest,requested_by,state,tombstone_sequence,tombstone_set_root,
          spool_locator,spool_digest,dispatch_fence,expires_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,'export',?,?,?,'principal:owner','requested',?,?,?,?,0,?,?,?)`,
      ).run(input.export_id, input.lane_id, input.correlation_id, input.idempotency_key,
        input.provider_instance_id, input.scope_digest, input.target_manifest_digest,
        input.payload_digest, input.tombstone_sequence, input.tombstone_set_root,
        input.spool_locator, input.spool_digest, input.expires_at, at, at);
      const insert = this.authority.db.prepare(
        "INSERT INTO memory_export_target_digests(export_id,target_digest,ordinal) VALUES(?,?,?)",
      );
      targetDigests.forEach((target, index) => insert.run(input.export_id, target, index));
      this.event(input.export_id, "requested", now);
    }).immediate();
    return this.required(input.export_id);
  }
  approve(id: string, command: { readonly request_id: string; readonly receipt_id: string;
    readonly command_digest: string }, now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_export_requests SET state='approved',control_request_id=?,control_receipt_id=?,
       control_command_digest=?,updated_at=? WHERE export_id=? AND state='requested'`,
    ).run(command.request_id, command.receipt_id, command.command_digest, now.toISOString(), id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
    this.event(id, "approved", now);
  }
  queue(id: string, value: { readonly request_id: string; readonly request_digest: string;
    readonly envelope_digest: string; readonly provider_idempotency_key: string;
    readonly delegation_id: string; readonly delegation_digest: string; readonly spool_locator: string },
  now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_export_requests SET state='queued',request_id=?,request_digest=?,envelope_digest=?,
       provider_idempotency_key=?,delegation_id=?,delegation_digest=?,spool_locator=?,updated_at=?
       WHERE export_id=? AND state='approved'`,
    ).run(value.request_id, value.request_digest, value.envelope_digest,
      value.provider_idempotency_key, value.delegation_id, value.delegation_digest,
      value.spool_locator, now.toISOString(), id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
    this.event(id, "queued", now);
  }
  begin(id: string, now: Date): MemoryExportRecord {
    return this.authority.db.transaction(() => {
      const row = this.required(id);
      if (row.state !== "queued" || row.request_digest === null) {
        if (["writing", "provider_proved", "available", "expired", "invalidated"].includes(row.state)) return row;
        throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
      }
      const at = now.toISOString();
      const changed = this.authority.db.prepare(
        `UPDATE memory_export_requests SET state='writing',dispatch_fence=1,dispatched_at=?,
         updated_at=? WHERE export_id=? AND state='queued' AND dispatch_fence=0`,
      ).run(at, at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_DISPATCH_RACE");
      const invocation = hash({ export_id: id, request_digest: row.request_digest, dispatch_fence: 1 });
      this.authority.db.prepare(
        `INSERT INTO memory_export_attempts(
          attempt_id,export_id,dispatch_fence,invocation_digest,outcome,dispatched_at,created_at
         ) VALUES(?,?,1,?,'dispatching',?,?)`,
      ).run(`memexp-attempt:v1:${invocation.slice(7)}`, id, invocation, at, at);
      this.event(id, "writing", now);
      return this.required(id);
    }).immediate();
  }
  accepted(id: string, acceptance: unknown, queueLocator: string, now: Date): void {
    const at = now.toISOString();
    const changed = this.authority.db.prepare(
      `UPDATE memory_export_attempts SET outcome='accepted',acceptance_digest=?,queue_locator_digest=?,
       outcome_code='PROVIDER_ACCEPTED',completed_at=? WHERE export_id=? AND outcome='dispatching'`,
    ).run(hash(acceptance), hash({ queue_locator: queueLocator }), at, id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
    this.authority.db.prepare(
      "UPDATE memory_export_requests SET spool_locator=NULL,failure_code=NULL,updated_at=? WHERE export_id=? AND state='writing'",
    ).run(at, id);
    this.event(id, "accepted", now, hash(acceptance));
  }
  uncertain(id: string, code: string, now: Date): void {
    const at = now.toISOString();
    this.authority.db.prepare(
      `UPDATE memory_export_attempts SET outcome='uncertain',outcome_code=?,completed_at=?
       WHERE export_id=? AND outcome='dispatching'`,
    ).run(code, at, id);
    this.authority.db.prepare(
      "UPDATE memory_export_requests SET failure_code=?,updated_at=? WHERE export_id=? AND state='writing'",
    ).run(code, at, id);
    this.event(id, "uncertain", now);
  }
  proved(id: string, proof: { readonly proof_id: string; readonly proof_digest: string;
    readonly provider_release_sha: string; readonly generation_id: string;
    readonly export_manifest_digest: string; readonly surface_manifest_digest: string;
    readonly proof_json: string }, now: Date): void {
    const at = now.toISOString();
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `INSERT INTO memory_export_proofs(
          export_id,proof_id,proof_digest,provider_release_sha,generation_id,export_manifest_digest,
          surface_manifest_digest,proof_json,verified_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(id, proof.proof_id, proof.proof_digest, proof.provider_release_sha,
        proof.generation_id, proof.export_manifest_digest, proof.surface_manifest_digest,
        proof.proof_json, at);
      const changed = this.authority.db.prepare(
        `UPDATE memory_export_requests SET state='provider_proved',provider_proof_digest=?,
         export_manifest_digest=?,failure_code=NULL,updated_at=? WHERE export_id=? AND state='writing'`,
      ).run(proof.proof_digest, proof.export_manifest_digest, at, id);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
      this.event(id, "provider_proved", now, proof.proof_digest);
    }).immediate();
  }
  available(id: string, files: number, bytes: number, now: Date): MemoryExportRecord {
    const at = now.toISOString();
    const changed = this.authority.db.prepare(
      `UPDATE memory_export_requests SET state='available',export_file_count=?,export_byte_count=?,
       available_at=?,artifact_expires_at=?,updated_at=?
       WHERE export_id=? AND state='provider_proved'`,
    ).run(files, bytes, at, new Date(now.getTime() + 86_400_000).toISOString(), at, id);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_EXPORT_TRANSITION_INVALID");
    this.authority.db.prepare(
      "UPDATE memory_export_proofs SET available_at=? WHERE export_id=?",
    ).run(at, id); this.event(id, "available", now); return this.required(id);
  }
  expire(id: string, now: Date): void {
    const changed = this.authority.db.prepare(
      "UPDATE memory_export_requests SET state='expired',updated_at=? WHERE export_id=? AND state='available' AND artifact_expires_at<=?",
    ).run(now.toISOString(), id, now.toISOString());
    if (changed.changes === 1) {
      this.authority.db.prepare("UPDATE memory_export_proofs SET expired_at=? WHERE export_id=?")
        .run(now.toISOString(), id); this.event(id, "expired", now);
    }
  }
  invalidate(id: string, sequence: number, now: Date): void {
    const changed = this.authority.db.prepare(
      `UPDATE memory_export_requests SET state='invalidated',invalidation_sequence=?,invalidated_at=?,
       updated_at=? WHERE export_id=? AND state='available'`,
    ).run(sequence, now.toISOString(), now.toISOString(), id);
    if (changed.changes === 1) {
      this.authority.db.prepare("UPDATE memory_export_proofs SET invalidated_at=? WHERE export_id=?")
        .run(now.toISOString(), id); this.event(id, "invalidated", now);
    }
  }
  private event(id: string, type: string, now: Date, proof?: string): void {
    const sequence = Number((this.authority.db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM memory_export_events WHERE export_id=?",
    ).get(id) as { readonly sequence: number }).sequence);
    const digest = hash({ export_id: id, sequence, event_type: type,
      proof_digest: proof ?? null, created_at: now.toISOString() });
    this.authority.db.prepare(
      `INSERT INTO memory_export_events(
        event_id,export_id,sequence,event_type,event_digest,proof_digest,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(`memexp-event:v1:${digest.slice(7)}`, id, sequence, type,
      digest, proof ?? null, now.toISOString());
  }
  private required(id: string): MemoryExportRecord {
    const row = this.get(id); if (row === undefined) throw new JarvisError("MEMORY_EXPORT_NOT_FOUND");
    return row;
  }
}
