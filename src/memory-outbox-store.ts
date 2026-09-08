import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { requireMemoryOutboxAuthority } from "./memory-outbox-authority.js";
import { MemoryOutboxLedger } from "./memory-outbox-ledger.js";
import { MemoryOutboxRecordReader } from "./memory-outbox-record.js";
import type { MemoryDispatch, MemoryObservation, MemoryOutboxActionV2, MemoryOutboxSagaV2,
  MemoryWriteResult } from "./memory-outbox-types.js";
import { memoryInvocation, memoryOutboxHash, memoryOutboxIdentity, memoryOutboxSettlementReceipt,
  parseMemoryOutboxAction, parseSagaRow, type MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new JarvisError("MEMORY_OUTBOX_TIME_INVALID");
  return value.toISOString();
}
export class MemoryOutboxStore {
  private readonly ledger: MemoryOutboxLedger;
  private readonly records: MemoryOutboxRecordReader;
  constructor(
    private readonly authority: AuthorityDb,
    private readonly deadlineMs: number,
    private readonly spoolRoots: MemoryOutboxSpoolRoots = {},
  ) {
    this.ledger = new MemoryOutboxLedger(authority);
    this.records = new MemoryOutboxRecordReader(authority, spoolRoots);
  }

  enqueue(command: Parameters<typeof parseMemoryOutboxAction>[0], now: Date): MemoryOutboxSagaV2 {
    const replay = this.records.terminalReplay(command);
    if (replay !== undefined) return replay;
    const action = parseMemoryOutboxAction(command, now, this.spoolRoots);
    requireMemoryOutboxAuthority(this.authority, action, now);
    return this.authority.db.transaction(() => this.insertOrReplay(action, now)).immediate();
  }
  private insertOrReplay(action: MemoryOutboxActionV2, now: Date): MemoryOutboxSagaV2 {
    requireMemoryOutboxAuthority(this.authority, action, now);
    const identity = memoryOutboxIdentity(action); const request = action.request;
    const existing = this.authority.db.prepare(
      "SELECT * FROM memory_outbox WHERE action_request_id=? OR candidate_id=? OR idempotency_key=?",
    ).get(action.command.request_id, request.candidate_id, request.idempotency_key);
    if (existing !== undefined) {
      const saga = parseSagaRow(existing);
      if (saga.outbox_id !== identity.outbox_id || saga.request_digest !== request.request_digest) {
        throw new JarvisError("MEMORY_OUTBOX_REPLAY_CONFLICT");
      }
      return saga;
    }
    const at = iso(now);
    this.authority.db.prepare(
      `INSERT INTO memory_outbox(
        outbox_id,candidate_id,action_request_id,action_receipt_id,action_command_digest,idempotency_key,
        request_id,request_digest,candidate_digest,classification_digest,operation,expected_page_id,
        expected_sid,expected_artifact_digest,state,expires_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(identity.outbox_id, request.candidate_id, action.command.request_id, action.command.receipt_id,
      action.command.command_digest, request.idempotency_key, request.request_id, request.request_digest,
      request.candidate_digest, request.classification_digest, request.operation,
      action.expected_artifact.page_id, action.expected_artifact.sid, action.expected_artifact.source_digest,
      "queued", request.expires_at, at, at);
    this.audit(identity.outbox_id, "queued", null, "queued", 0, action.command.request_id, identity.digest, at);
    return this.getRequired(identity.outbox_id);
  }
  get(id: string): MemoryOutboxSagaV2 | undefined { return this.records.get(id); }
  observationRequest(saga: MemoryOutboxSagaV2) {
    // Historical reconstruction for observation only; never renew write authority.
    return this.records.request(saga.outbox_id, new Date(saga.created_at));
  }
  list(state: string | undefined, limit: number): readonly MemoryOutboxSagaV2[] {
    return this.records.list(state, limit);
  }
  recoverDispatching(now: Date): number {
    const at = iso(now); const rows = this.authority.db.prepare(
      "SELECT outbox_id,lease_fence FROM memory_outbox WHERE request_profile='legacy' AND state='dispatching' AND lease_expires_at<=? ORDER BY outbox_id",
    ).all(at) as Array<{ outbox_id: string; lease_fence: number }>;
    let count = 0;
    for (const row of rows) count += this.authority.db.transaction(() => {
      const changed = this.authority.db.prepare(
        `UPDATE memory_outbox SET state='reconciling',lease_owner=NULL,lease_expires_at=NULL,
         failure_code='DISPATCH_OUTCOME_UNKNOWN',updated_at=? WHERE outbox_id=? AND state='dispatching' AND lease_expires_at<=?`,
      ).run(at, row.outbox_id, at).changes;
      if (changed === 1) this.event(row.outbox_id, row.lease_fence, "dispatch_uncertain", "DISPATCH_OUTCOME_UNKNOWN", at);
      return changed;
    }).immediate();
    return count;
  }
  claimDispatch(worker: string, now: Date, leaseMs: number): MemoryOutboxSagaV2 | undefined {
    const at = iso(now); const until = new Date(now.getTime() + leaseMs).toISOString();
    return this.authority.db.transaction(() => {
      const row = this.authority.db.prepare(
        `SELECT * FROM memory_outbox WHERE request_profile='legacy' AND action_request_id IS NOT NULL AND
         (state='queued' OR (state='claimed' AND lease_expires_at<=?)) ORDER BY created_at,outbox_id LIMIT 1`,
      ).get(at);
      if (row === undefined) return undefined;
      const prior = parseSagaRow(row); const fence = prior.lease_fence + 1;
      let request; let command; let action;
      try {
        request = this.request(prior.outbox_id, now); command = this.command(prior.outbox_id);
        action = parseMemoryOutboxAction(command, now, this.spoolRoots);
        if (request.request_digest !== action.request.request_digest) throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE");
        requireMemoryOutboxAuthority(this.authority, action, now, false);
      } catch (error) {
        const expired = Date.parse(String((row as Record<string, unknown>)["expires_at"])) <= now.getTime();
        const state = expired ? "expired" : "failed"; const code = expired ? "MEMORY_OUTBOX_EXPIRED" : "MEMORY_OUTBOX_AUTHORITY_INVALID";
        this.authority.db.prepare(
          "UPDATE memory_outbox SET state=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE outbox_id=?",
        ).run(state, code, at, prior.outbox_id);
        this.event(prior.outbox_id, Math.max(1, fence), state, code, at);
        this.audit(prior.outbox_id, state, prior.state, state, fence, prior.request_id, null, at);
        if (!(error instanceof Error)) throw error;
        return undefined;
      }
      const changes = this.authority.db.prepare(
        `UPDATE memory_outbox SET state='claimed',lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
         WHERE outbox_id=? AND (state='queued' OR (state='claimed' AND lease_expires_at<=?))`,
      ).run(worker, fence, until, at, prior.outbox_id, at).changes;
      if (changes !== 1) return undefined;
      this.audit(prior.outbox_id, "claimed", prior.state, "claimed", fence, command.request_id, null, at);
      return this.getRequired(prior.outbox_id);
    }).immediate();
  }
  markDispatch(outboxId: string, worker: string, fence: number, now: Date): MemoryDispatch {
    const at = iso(now); const deadline = new Date(now.getTime() + this.deadlineMs).toISOString();
    return this.authority.db.transaction(() => {
      const saga = this.getRequired(outboxId);
      if (new MemoryProjectionAuthority(this.authority).isProjectionIdSuppressed(saga.candidate_id)) {
        throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
      }
      const invocation = memoryInvocation(outboxId, saga.request_digest, fence);
      const changed = this.authority.db.prepare(
        `UPDATE memory_outbox SET state='dispatching',dispatch_fence=?,dispatched_at=?,reconcile_deadline_at=?,updated_at=?
         WHERE outbox_id=? AND state='claimed' AND lease_owner=? AND lease_fence=? AND lease_expires_at>?`,
      ).run(fence, at, deadline, at, outboxId, worker, fence, at).changes;
      if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
      this.authority.db.prepare(
        `INSERT INTO memory_outbox_attempts(
          attempt_id,outbox_id,dispatch_fence,invocation_digest,request_digest,outcome,
          dispatched_at,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(invocation.attempt_id, outboxId, fence, invocation.digest, saga.request_digest,
        "dispatching", at, at, at);
      this.event(outboxId, fence, "dispatch_authority_spent", null, at, invocation.attempt_id);
      this.audit(outboxId, "dispatching", "claimed", "dispatching", fence, saga.request_id, invocation.digest, at);
      return { saga: this.getRequired(outboxId), request: this.request(outboxId, now),
        attempt_id: invocation.attempt_id, invocation_digest: invocation.digest };
    }).immediate();
  }
  recordResult(dispatch: MemoryDispatch, result: MemoryWriteResult, now: Date): MemoryOutboxSagaV2 {
    const at = iso(now); const accepted = result.kind === "accepted";
    const receipt = accepted ? memoryOutboxHash("memory-outbox-acceptance", result) : null;
    const code = accepted ? "PROVIDER_ACCEPTED" : result.code;
    this.authority.db.transaction(() => {
      const changed = this.authority.db.prepare(
        `UPDATE memory_outbox_attempts SET outcome=?,outcome_code=?,accepted_result_json=?,acceptance_receipt_digest=?,
         completed_at=?,updated_at=? WHERE attempt_id=? AND outcome='dispatching'`,
      ).run(accepted ? "accepted" : "uncertain", code, accepted ? canonicalize(result) : null,
        receipt, at, at, dispatch.attempt_id).changes;
      if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
      const eventType = accepted ? "provider_accepted" : "dispatch_uncertain";
      this.event(dispatch.saga.outbox_id, dispatch.saga.dispatch_fence ?? 0, eventType, code, at,
        dispatch.attempt_id, receipt ?? undefined);
    }).immediate();
    return this.authority.db.transaction(() => {
      const transitioned = this.authority.db.prepare(
        `UPDATE memory_outbox SET state='reconciling',lease_owner=NULL,lease_expires_at=NULL,
         failure_code=?,updated_at=? WHERE outbox_id=? AND state='dispatching' AND dispatch_fence=?`,
      ).run(accepted ? null : code, at, dispatch.saga.outbox_id, dispatch.saga.dispatch_fence).changes;
      if (transitioned !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
      this.audit(dispatch.saga.outbox_id, "reconciling", "dispatching", "reconciling",
        dispatch.saga.dispatch_fence ?? 0, dispatch.saga.request_id, receipt, at);
      return this.getRequired(dispatch.saga.outbox_id);
    }).immediate();
  }

  claimReconcile(worker: string, now: Date, leaseMs: number): MemoryOutboxSagaV2 | undefined {
    const at = iso(now); const until = new Date(now.getTime() + leaseMs).toISOString();
    return this.authority.db.transaction(() => {
      const row = this.authority.db.prepare(
        `SELECT * FROM memory_outbox WHERE request_profile='legacy' AND state='reconciling' AND (lease_owner IS NULL OR lease_expires_at<=?)
         ORDER BY updated_at,outbox_id LIMIT 1`,
      ).get(at);
      if (row === undefined) return undefined;
      const saga = parseSagaRow(row); const fence = saga.lease_fence + 1;
      const changed = this.authority.db.prepare(
        `UPDATE memory_outbox SET lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
         WHERE outbox_id=? AND state='reconciling' AND (lease_owner IS NULL OR lease_expires_at<=?)`,
      ).run(worker, fence, until, at, saga.outbox_id, at).changes;
      return changed === 1 ? this.getRequired(saga.outbox_id) : undefined;
    }).immediate();
  }
  recordObservation(saga: MemoryOutboxSagaV2, observation: MemoryObservation, now: Date): MemoryOutboxSagaV2 {
    const at = iso(now); const timedOut = saga.reconcile_deadline_at !== null
      && now.getTime() >= Date.parse(saga.reconcile_deadline_at);
    return this.authority.db.transaction(() => {
      this.requireReconcileFence(saga, at);
      if (observation.kind === "conflict") return this.terminalObservation(saga, observation, "conflict", at);
      if (observation.kind === "match") return this.terminalObservation(saga, observation, "settled", at);
      this.event(saga.outbox_id, saga.lease_fence, "artifact_missing", observation.code, at,
        this.attempt(saga.outbox_id).attempt_id, undefined, observation);
      if (timedOut) this.event(saga.outbox_id, saga.lease_fence, "reconcile_timeout", "RECONCILE_TIMEOUT", at,
        this.attempt(saga.outbox_id).attempt_id);
      this.authority.db.prepare(
        `UPDATE memory_outbox SET lease_owner=NULL,lease_expires_at=NULL,failure_code=?,updated_at=?
         WHERE outbox_id=? AND state='reconciling' AND lease_fence=?`,
      ).run(timedOut ? "RECONCILE_TIMEOUT" : observation.code, at, saga.outbox_id, saga.lease_fence);
      return this.getRequired(saga.outbox_id);
    }).immediate();
  }
  private terminalObservation(saga: MemoryOutboxSagaV2, observation: MemoryObservation,
    state: "settled" | "conflict", at: string): MemoryOutboxSagaV2 {
    const eventType = state === "settled" ? "artifact_observed" : "artifact_conflict";
    const attempt = this.attempt(saga.outbox_id);
    const observationDigest = this.event(saga.outbox_id, saga.lease_fence, eventType, observation.code, at,
      attempt.attempt_id, undefined, observation, true);
    const receipt = state === "settled"
      ? memoryOutboxSettlementReceipt({ saga, observation, attempt,
        settled: { observationDigest, at } })
      : null;
    if (receipt !== null) this.event(saga.outbox_id, saga.lease_fence, "settled", observation.code, at,
      attempt.attempt_id, receipt, observation, true);
    const changed = this.authority.db.prepare(
      `UPDATE memory_outbox SET state=?,lease_owner=NULL,lease_expires_at=NULL,failure_code=?,
       settlement_receipt_digest=?,settled_at=?,updated_at=? WHERE outbox_id=? AND state='reconciling' AND lease_fence=?`,
    ).run(state, state === "conflict" ? observation.code : null, receipt, state === "settled" ? at : null,
      at, saga.outbox_id, saga.lease_fence).changes;
    if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
    this.audit(saga.outbox_id, state, "reconciling", state, saga.lease_fence, saga.request_id, receipt, at);
    return this.getRequired(saga.outbox_id);
  }

  private request(outboxId: string, now: Date) { return this.records.request(outboxId, now); }
  private command(outboxId: string) { return this.records.command(outboxId); }
  private getRequired(id: string): MemoryOutboxSagaV2 {
    return this.get(id) ?? (() => { throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE"); })();
  }
  private attempt(id: string) { return this.records.attempt(id); }
  private requireReconcileFence(saga: MemoryOutboxSagaV2, at: string): void {
    const row = this.authority.db.prepare(
      `SELECT 1 FROM memory_outbox WHERE outbox_id=? AND state='reconciling' AND lease_fence=?
       AND lease_owner=? AND lease_expires_at>?`,
    ).get(saga.outbox_id, saga.lease_fence, saga.lease_owner, at);
    if (row === undefined) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
  }
  private event(outboxId: string, fence: number, type: string, code: string | null, at: string,
    attemptId?: string, receipt?: string, observation?: MemoryObservation, required = false): string {
    return this.ledger.event(outboxId, fence, type, code, at, attemptId, receipt, observation, required);
  }
  private audit(id: string, event: string, prior: string | null, next: string, fence: number,
    cause: string, receipt: string | null, at: string): void {
    this.ledger.audit(id, event, prior, next, fence, cause, receipt, at);
  }
}
