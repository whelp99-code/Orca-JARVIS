import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import {
  companyCheckpointSchema, companyOperationId, finishProgressResponseSchema, freshnessReadResponseSchema,
  loadCompanyFreshness, reserveProgressRequestSchema, reserveProgressResponseSchema,
  type CompanyCheckpoint, type CompanyFreshnessProvider, type CompanyProgressOperation, type ReserveProgressRequest,
  type FinishProgressRequest,
  type CompanyScope,
} from "./company-freshness.js";
import { CompanyPeerCalls } from "./company-peer-calls.js";
import { companyFreshnessRequestDigest } from "./company-freshness-envelope.js";
import { assertCompanyLocalProgress, companyOtherStorePrefix } from "./company-local-progress.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { controlCommandDigest as commandDigest } from "./control-plane-contract.js";

type CommandOperation = Exclude<CompanyProgressOperation, "delete">;

function advances(previous: CompanyCheckpoint, next: CompanyCheckpoint): boolean {
  const prefix = (a: number, ar: string, b: number, br: string) => b === a ? ar === br : b > a && ar !== br;
  return next.approval_binding_digest === previous.approval_binding_digest
    && next.approval_policy_version === previous.approval_policy_version
    && next.operational_epoch === previous.operational_epoch
    && next.intent_sequence === previous.intent_sequence + 1
    && next.intent_root !== previous.intent_root
    && prefix(previous.revocation_sequence, previous.revocation_root, next.revocation_sequence, next.revocation_root)
    && (["jarvis", "second_brain"] as const).every(store => {
      const a = previous.stores[store]; const b = next.stores[store];
      return prefix(a.receipt_sequence, a.receipt_root, b.receipt_sequence, b.receipt_root)
        && prefix(a.terminal_sequence, a.terminal_root, b.terminal_sequence, b.terminal_root)
        && prefix(a.deletion_sequence, a.deletion_root, b.deletion_sequence, b.deletion_root);
    });
}

export interface CompanyProgressReservation {
  scope: { provider_instance_id: string; workspace_id: string };
  operation_id: string;
  request_id: string;
  operation: CommandOperation;
  reservation_id: string;
  checkpoint: CompanyCheckpoint;
  reserve_request: ReserveProgressRequest;
}

/** A local checkpoint is only an observed comparison value; the provider selects its own head. */
export class CompanyProgress {
  constructor(
    private readonly db: AuthorityDb,
    private readonly provider: CompanyFreshnessProvider = loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" }),
  ) {}

  /** Only this kind can adopt a provider-attested retained prefix belonging entirely to SB. */
  synchronize(scope: CompanyScope, now: Date): CompanyCheckpoint {
    if (this.db.db.inTransaction) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    if (this.provider.kind === "sb_company_db") {
      const pending = this.db.db.prepare(
        `SELECT request_id FROM company_progress_reservations
         WHERE provider_instance_id=? AND workspace_id=? AND evidence_digest IS NULL
         UNION ALL SELECT request_id FROM company_peer_calls
         WHERE provider_instance_id=? AND workspace_id=? AND state IN ('invoking','uncertain') LIMIT 1`,
      ).get(scope.provider_instance_id, scope.workspace_id, scope.provider_instance_id, scope.workspace_id) as { request_id: string } | undefined;
      if (pending) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN", `COMPANY_PROGRESS_UNCERTAIN: request_id=${pending.request_id}`);
    }
    const row = this.db.db.prepare(
      "SELECT checkpoint_json FROM company_freshness_checkpoints WHERE provider_instance_id=? AND workspace_id=?",
    ).get(scope.provider_instance_id, scope.workspace_id) as { checkpoint_json: string } | undefined;
    if (!row) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const checkpoint = companyCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
    if (this.provider.kind === "sb_company_db") assertCompanyLocalProgress(this.db, scope, checkpoint);
    const challenge = randomUUID();
    let raw: unknown;
    try {
      raw = this.provider.readFreshness({ schema_version: 2, scope, installation_id: "installation:jarvis", challenge, observed_checkpoint: checkpoint });
    } catch { throw new JarvisError("COMPANY_FRESHNESS_REQUIRED"); }
    const read = freshnessReadResponseSchema.safeParse(raw);
    if (!read.success || read.data.challenge !== challenge || canonicalize(read.data.scope) !== canonicalize(scope)) {
      throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    }
    if (read.data.status === "mismatch") throw new JarvisError("COMPANY_OPERATIONAL_ROLLBACK");
    if (read.data.status !== "ready" || read.data.checkpoint === null) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const next = read.data.checkpoint;
    if (canonicalize(next) === canonicalize(checkpoint)) return checkpoint;
    if (this.provider.kind !== "sb_company_db") throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    if (!companyOtherStorePrefix(checkpoint, next)) throw new JarvisError("COMPANY_OPERATIONAL_ROLLBACK");
    this.db.db.transaction(() => {
      if (!this.db.db.prepare(
        "SELECT 1 FROM company_freshness_checkpoints WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?",
      ).get(scope.provider_instance_id, scope.workspace_id, row.checkpoint_json)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      assertCompanyLocalProgress(this.db, scope, checkpoint);
      const updated = this.db.db.prepare(
        `UPDATE company_freshness_checkpoints SET checkpoint_json=?,updated_at=?
         WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?`,
      ).run(canonicalize(next), now.toISOString(), scope.provider_instance_id, scope.workspace_id, row.checkpoint_json);
      if (updated.changes !== 1) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }).immediate();
    return next;
  }

  assertReservation(token: CompanyProgressReservation): void {
    const row = this.db.db.prepare(
      "SELECT checkpoint_json FROM company_freshness_checkpoints WHERE provider_instance_id=? AND workspace_id=?",
    ).get(token.scope.provider_instance_id, token.scope.workspace_id) as { checkpoint_json: string } | undefined;
    if (!row || row.checkpoint_json !== canonicalize(token.checkpoint)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    if (this.provider.kind === "sb_company_db") assertCompanyLocalProgress(this.db, token.scope, token.checkpoint);
  }

  pending(command: CompanyCommandV2, operation: CommandOperation): CompanyProgressReservation | undefined {
    const scope = { provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id };
    const operationId = companyOperationId({ scope, request_id: command.request_id,
      command_digest: commandDigest(command), operation });
    const row = this.db.db.prepare(
      "SELECT * FROM company_progress_reservations WHERE operation_id=? AND evidence_digest IS NULL",
    ).get(operationId) as { reservation_id: string; checkpoint_json: string; reserve_request_json: string } | undefined;
    return row ? { scope, operation_id: operationId, request_id: command.request_id, operation,
      reservation_id: row.reservation_id, checkpoint: companyCheckpointSchema.parse(JSON.parse(row.checkpoint_json)),
      reserve_request: reserveProgressRequestSchema.parse(JSON.parse(row.reserve_request_json)) } : undefined;
  }

  reserve(command: CompanyCommandV2, operation: CommandOperation, eventDigest: string, now: Date): CompanyProgressReservation {
    if (this.db.db.inTransaction) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const scope = { provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id };
    const pending = this.db.db.prepare(
      `SELECT request_id FROM company_progress_reservations
       WHERE provider_instance_id=? AND workspace_id=? AND evidence_digest IS NULL LIMIT 1`,
    ).get(scope.provider_instance_id, scope.workspace_id) as { request_id: string } | undefined;
    if (pending) {
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN", `COMPANY_PROGRESS_UNCERTAIN: request_id=${pending.request_id}`);
    }
    const operationId = companyOperationId({ scope, request_id: command.request_id, command_digest: commandDigest(command), operation });
    if (this.db.db.prepare("SELECT 1 FROM company_progress_reservations WHERE operation_id=?").get(operationId)) {
      throw new JarvisError("COMPANY_DUPLICATE_OPERATION");
    }
    const calls = this.provider.kind === "sb_company_db" ? new CompanyPeerCalls(this.db) : undefined;
    if (calls && !["decide_approve", "decide_reject", "complete"].includes(operation)) throw new JarvisError("COMPANY_CONTRACT_INVALID");
    const previousCall = calls?.read(operationId);
    const original = previousCall ? reserveProgressRequestSchema.parse(JSON.parse(previousCall.original_arguments_json)) : undefined;
    if (original && (original.operation_id !== operationId || original.operation !== operation || original.event_digest !== eventDigest
      || canonicalize(original.scope) !== canonicalize(scope))) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    let recovering = previousCall !== undefined && previousCall.state !== "prepared";
    const checkpoint = recovering && original ? original.expected_checkpoint : this.synchronize(scope, now);
    if (original && !recovering && canonicalize(original.expected_checkpoint) !== canonicalize(checkpoint)) {
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }
    if (checkpoint.approval_binding_digest !== command.args.approval_binding_digest
      || checkpoint.approval_policy_version !== command.args.approval_policy_version) throw new JarvisError("ENROLLMENT_REQUIRED");
    let raw: unknown;
    const request: ReserveProgressRequest = original ?? { schema_version: 2, scope, operation_id: operationId,
      operation, expected_checkpoint: checkpoint, event_digest: eventDigest, challenge: randomUUID() };
    const call = calls?.prepare({
      operation_id: operationId, ...scope, request_id: command.request_id, operation,
      transition_request_digest: companyFreshnessRequestDigest({ method: "reserve_progress", request, evidence: null }),
      arguments: request,
    }, now);
    if (call && call.state !== "prepared") recovering = true;
    if (call?.state === "prepared") calls?.invoking(operationId, now);
    const wire = recovering ? { ...request, challenge: randomUUID() } : request;
    try { raw = this.provider.reserveProgress(wire); }
    catch { calls?.uncertain(operationId, now); throw new JarvisError("COMPANY_FRESHNESS_REQUIRED"); }
    const parsed = reserveProgressResponseSchema.safeParse(raw);
    if (!parsed.success) { calls?.uncertain(operationId, now); throw new JarvisError("COMPANY_FRESHNESS_REQUIRED"); }
    const response = parsed.data;
    if (response.outcome === "error") { calls?.uncertain(operationId, now); throw new JarvisError(response.code); }
    if (response.challenge !== wire.challenge || canonicalize(response.scope) !== canonicalize(scope)) {
      calls?.uncertain(operationId, now);
      throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    }
    if (!["reserved", "already_reserved"].includes(response.outcome) || !response.reservation_id || !response.checkpoint) {
      calls?.uncertain(operationId, now);
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }
    if (!calls && response.outcome !== "reserved") throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    if (!advances(checkpoint, response.checkpoint)) { calls?.uncertain(operationId, now); throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN"); }
    const token: CompanyProgressReservation = { scope, operation_id: operationId, operation, request_id: command.request_id,
      reservation_id: response.reservation_id, checkpoint: response.checkpoint, reserve_request: request };
    try { this.db.db.transaction(() => {
      if (calls) assertCompanyLocalProgress(this.db, scope, checkpoint);
      if (calls && call?.state === "found") {
        const previous = reserveProgressResponseSchema.parse(calls.projection(call));
        if (previous.outcome === "error" || previous.reservation_id !== response.reservation_id
          || canonicalize(previous.checkpoint) !== canonicalize(response.checkpoint)
          || canonicalize(previous.scope) !== canonicalize(response.scope)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      if (calls && call?.state !== "found") calls.found(operationId, response, now);
      this.db.db.prepare(
        `INSERT INTO company_progress_reservations(operation_id,provider_instance_id,workspace_id,request_id,operation,
         reservation_id,reserve_request_json,checkpoint_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(operationId, scope.provider_instance_id, scope.workspace_id, command.request_id, operation,
        token.reservation_id, canonicalize(request), canonicalize(token.checkpoint), now.toISOString());
      const updated = this.db.db.prepare(
        `UPDATE company_freshness_checkpoints SET checkpoint_json=?,updated_at=?
         WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?`,
      ).run(canonicalize(token.checkpoint), now.toISOString(), scope.provider_instance_id, scope.workspace_id, canonicalize(checkpoint));
      if (updated.changes !== 1) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }).immediate(); }
    catch (error) { calls?.uncertain(operationId, now); throw error; }
    if (recovering || response.outcome === "already_reserved") throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN",
      `COMPANY_PROGRESS_UNCERTAIN: request_id=${command.request_id}`);
    return token;
  }

  /** Provider acknowledgement precedes the local checkpoint/publication transaction. */
  finish(token: CompanyProgressReservation, evidenceDigest: string, terminalState: FinishProgressRequest["terminal_state"], now: Date, publish?: () => void): void {
    if (this.db.db.inTransaction) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    const challenge = randomUUID();
    let raw: unknown;
    try {
      raw = this.provider.finishProgress({
        schema_version: 2, scope: token.scope, operation_id: token.operation_id, reservation_id: token.reservation_id,
        expected_checkpoint: token.checkpoint, evidence_digest: evidenceDigest, terminal_state: terminalState, challenge,
      });
    } catch { throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN"); }
    const parsed = finishProgressResponseSchema.safeParse(raw);
    if (!parsed.success) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    const response = parsed.data;
    if (response.outcome === "error") throw new JarvisError(response.code);
    if (response.challenge !== challenge || canonicalize(response.scope) !== canonicalize(token.scope)
      || !["recorded", "already_recorded"].includes(response.outcome) || !response.checkpoint) {
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }
    if (!advances(token.checkpoint, response.checkpoint)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    const finalCheckpoint = response.checkpoint;
    this.db.db.transaction(() => {
      if (this.provider.kind === "sb_company_db") {
        const acknowledged = this.db.db.prepare(
          `UPDATE company_progress_evidence_outbox SET acknowledged=1
           WHERE operation_id=? AND evidence_digest=? AND acknowledged=0`,
        ).run(token.operation_id, evidenceDigest);
        if (acknowledged.changes !== 1 && !this.db.db.prepare(
          "SELECT 1 FROM company_progress_evidence_outbox WHERE operation_id=? AND evidence_digest=? AND acknowledged=1",
        ).get(token.operation_id, evidenceDigest)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      const recorded = this.db.db.prepare(
        `UPDATE company_progress_reservations SET finished_checkpoint_json=?,evidence_digest=?,terminal_state=?
         WHERE operation_id=? AND evidence_digest IS NULL`,
      ).run(canonicalize(response.checkpoint), evidenceDigest, terminalState, token.operation_id);
      if (recorded.changes !== 1) {
        const previous = this.db.db.prepare("SELECT evidence_digest,terminal_state,finished_checkpoint_json FROM company_progress_reservations WHERE operation_id=?")
          .get(token.operation_id) as { evidence_digest: string; terminal_state: string; finished_checkpoint_json: string } | undefined;
        if (!previous || previous.evidence_digest !== evidenceDigest || previous.terminal_state !== terminalState
          || previous.finished_checkpoint_json !== canonicalize(finalCheckpoint)) {
          throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
        }
        if (this.provider.kind === "sb_company_db") {
          const current = this.db.db.prepare(
            "SELECT checkpoint_json FROM company_freshness_checkpoints WHERE provider_instance_id=? AND workspace_id=?",
          ).get(token.scope.provider_instance_id, token.scope.workspace_id) as { checkpoint_json: string } | undefined;
          if (!current) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
          assertCompanyLocalProgress(this.db, token.scope, companyCheckpointSchema.parse(JSON.parse(current.checkpoint_json)));
          return;
        }
      } else {
        const updated = this.db.db.prepare(
          `UPDATE company_freshness_checkpoints SET checkpoint_json=?,updated_at=?
           WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?`,
        ).run(canonicalize(response.checkpoint), now.toISOString(), token.scope.provider_instance_id, token.scope.workspace_id,
          canonicalize(token.checkpoint));
        if (updated.changes !== 1) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      if (this.provider.kind === "sb_company_db") assertCompanyLocalProgress(this.db, token.scope, finalCheckpoint);
      publish?.();
    }).immediate();
  }
}
