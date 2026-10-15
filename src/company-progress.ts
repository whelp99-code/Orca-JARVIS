import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import {
  companyCheckpointSchema, companyOperationId, finishProgressResponseSchema, freshnessReadResponseSchema,
  loadCompanyFreshness, reserveProgressRequestSchema, reserveProgressResponseSchema,
  type CompanyCheckpoint, type CompanyFreshnessProvider, type CompanyProgressOperation, type ReserveProgressRequest,
  type FinishProgressRequest,
} from "./company-freshness.js";
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
    const row = this.db.db.prepare(
      "SELECT checkpoint_json FROM company_freshness_checkpoints WHERE provider_instance_id=? AND workspace_id=?",
    ).get(scope.provider_instance_id, scope.workspace_id) as { checkpoint_json: string } | undefined;
    if (!row) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const checkpoint = companyCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
    if (checkpoint.approval_binding_digest !== command.args.approval_binding_digest
      || checkpoint.approval_policy_version !== command.args.approval_policy_version) throw new JarvisError("ENROLLMENT_REQUIRED");
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
    if (read.data.status !== "ready" || canonicalize(read.data.checkpoint) !== canonicalize(checkpoint)) {
      throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    }
    const request: ReserveProgressRequest = { schema_version: 2, scope, operation_id: operationId,
      operation, expected_checkpoint: checkpoint, event_digest: eventDigest, challenge: randomUUID() };
    try { raw = this.provider.reserveProgress(request); }
    catch { throw new JarvisError("COMPANY_FRESHNESS_REQUIRED"); }
    const parsed = reserveProgressResponseSchema.safeParse(raw);
    if (!parsed.success) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    const response = parsed.data;
    if (response.outcome === "error") throw new JarvisError(response.code);
    if (response.challenge !== request.challenge || canonicalize(response.scope) !== canonicalize(scope)) {
      throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
    }
    if (response.outcome !== "reserved" || !response.reservation_id || !response.checkpoint) {
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }
    if (!advances(checkpoint, response.checkpoint)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    const token: CompanyProgressReservation = { scope, operation_id: operationId, operation, request_id: command.request_id,
      reservation_id: response.reservation_id, checkpoint: response.checkpoint, reserve_request: request };
    this.db.db.transaction(() => {
      this.db.db.prepare(
        `INSERT INTO company_progress_reservations(operation_id,provider_instance_id,workspace_id,request_id,operation,
         reservation_id,reserve_request_json,checkpoint_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(operationId, scope.provider_instance_id, scope.workspace_id, command.request_id, operation,
        token.reservation_id, canonicalize(request), canonicalize(token.checkpoint), now.toISOString());
      const updated = this.db.db.prepare(
        `UPDATE company_freshness_checkpoints SET checkpoint_json=?,updated_at=?
         WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?`,
      ).run(canonicalize(token.checkpoint), now.toISOString(), scope.provider_instance_id, scope.workspace_id, row.checkpoint_json);
      if (updated.changes !== 1) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    })();
    return token;
  }

  finish(token: CompanyProgressReservation, evidenceDigest: string, terminalState: FinishProgressRequest["terminal_state"], now: Date): void {
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
    this.db.db.transaction(() => {
      const recorded = this.db.db.prepare(
        `UPDATE company_progress_reservations SET finished_checkpoint_json=?,evidence_digest=?,terminal_state=?
         WHERE operation_id=? AND evidence_digest IS NULL`,
      ).run(canonicalize(response.checkpoint), evidenceDigest, terminalState, token.operation_id);
      if (recorded.changes !== 1) {
        const previous = this.db.db.prepare("SELECT evidence_digest,terminal_state FROM company_progress_reservations WHERE operation_id=?")
          .get(token.operation_id) as { evidence_digest: string; terminal_state: string } | undefined;
        if (!previous || previous.evidence_digest !== evidenceDigest || previous.terminal_state !== terminalState) {
          throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
        }
        return;
      }
      const updated = this.db.db.prepare(
        `UPDATE company_freshness_checkpoints SET checkpoint_json=?,updated_at=?
         WHERE provider_instance_id=? AND workspace_id=? AND checkpoint_json=?`,
      ).run(canonicalize(response.checkpoint), now.toISOString(), token.scope.provider_instance_id, token.scope.workspace_id,
        canonicalize(token.checkpoint));
      if (updated.changes !== 1) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    })();
  }
}
