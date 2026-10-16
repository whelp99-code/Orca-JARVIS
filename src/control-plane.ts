import { randomUUID } from "node:crypto";
import { stageControlCommand } from "./control-command-stage.js";
import { readControlCommand, listControlCommands, decodeStoredControlCommand } from "./control-command-read.js";
import { canonicalize } from "./canonical.js"; import { validateControlAction } from "./control-actions.js"; import {
  controlValueDigest as hash, isControlRecord as isRecord, isNonemptyControlValue as nonempty, verifyCommandApproval, } from "./control-plane-contract.js";
import type { ActionLevel, ClaimedControlCommand, CommandApprovalReceipt, ControlCancelInput, ControlCommandRequestInput,
  ControlEventInput, StoredControlCommand, } from "./control-plane-contract.js"; import { AuthorityDb, JarvisError } from "./db.js";
import { MemorySurfaceAuthority } from "./memory-surface-authority.js"; export {
  COMMAND_APPROVAL_DOMAIN, controlCommandDigest, signCommandApproval, verifyCommandApproval, } from "./control-plane-contract.js"; export type { ActionLevel,
  ClaimedControlCommand, CommandApprovalReceipt, ControlCancelInput, ControlCommandRequestInput, ControlCommandState, ControlEventInput, StoredControlCommand,
} from "./control-plane-contract.js"; const validOutcomeStates = new Set(["completed", "failed", "uncertain"]);
import { memoryOutboxControlProof } from "./memory-outbox-control-proof.js";
import { validateMemoryCandidateScopeProposal } from "./memory-candidate-scope.js";
import { runImmediate } from "./sqlite-contention.js";
import { companyArgumentsSchema } from "./company-candidate-contract.js";
import { decodeCompanyCommandV2 } from "./company-candidate-v2-contract.js";
import { assertCurrentCompanyPin, readCompanyApprovalBinding } from "./company-approval-binding.js";
import { CompanyProgress, type CompanyProgressReservation } from "./company-progress.js";
import { loadCompanyFreshness, type CompanyFreshnessProvider } from "./company-freshness.js";
import { stageCompanyProgressEvidence } from "./company-progress-evidence.js";
function finiteDate(date: Date, code: string): number { const time = date.getTime(); if (!Number.isFinite(time)) throw new JarvisError(code); return time; }
function finiteIso(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.NaN; } export class ControlPlane {
  constructor(private readonly authority: AuthorityDb,
    private readonly companyFreshness: CompanyFreshnessProvider = loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" })) {}
  private event(input: ControlEventInput): void {
    const created = input.created_at ?? new Date().toISOString(); const payloadJson = canonicalize(input.payload); this.authority.db .prepare(
        `INSERT INTO control_events(
          event_id,schema_version,event_type,source,subject,correlation_id,causation_id,
          payload_json,payload_digest,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ) .run( input.event_id, 1, input.event_type, input.source, input.subject, input.correlation_id ?? null, input.causation_id ?? null, payloadJson,
        hash(payloadJson), created, ); } emit(input: ControlEventInput): void { this.event(input); }
  private legacyRevoked(...references: Array<string | undefined>): boolean { const unique = [...new Set(references.filter(nonempty))];
    return unique.some((reference) => Boolean(this.authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(reference))); }
  private controlRevoked(requestId: string, receiptId?: string): boolean { if (receiptId)
      return Boolean(this.authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?").get(requestId, receiptId));
    return Boolean(this.authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=?").get(requestId)); }
  private commandRevoked(requestId: string, commandDigest: string, receiptId?: string): boolean {
    return this.controlRevoked(requestId, receiptId) || this.legacyRevoked(requestId, commandDigest, receiptId); }
  private parseStoredAction(row: Record<string, unknown>): { action: string; action_level: ActionLevel; target: Record<string, unknown>;
    args: Record<string, unknown>; } { const target: unknown = JSON.parse(String(row.target_json)); const args: unknown = JSON.parse(String(row.args_json));
    if (!isRecord(target) || !isRecord(args)) throw new JarvisError("CONTROL_COMMAND_INVALID");
    return { action: String(row.action), action_level: Number(row.action_level) as ActionLevel, target, args }; }
  stage(input: ControlCommandRequestInput, now = new Date()): StoredControlCommand {
    return stageControlCommand(this.authority, input, now, event => this.event(event));
  } decide(receipt: CommandApprovalReceipt, decisionAt?: Date | (() => Date)): void {
    const readNow = () => typeof decisionAt === "function" ? decisionAt() : decisionAt ?? new Date();
    let now = readNow();
    const nowMs = finiteDate(now, "CONTROL_APPROVAL_INVALID");
    const request = this.authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?").get(receipt.request_id) as | Record<string, unknown>
      | undefined; if (!request) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
    const companyV2 = request.action === "company.candidate.transition" && Number(request.schema_version) === 2
      ? decodeCompanyCommandV2({
        schema_version: 2, request_id: request.request_id, action: request.action, action_level: request.action_level,
        target: JSON.parse(String(request.target_json)), args: JSON.parse(String(request.args_json)), reversible: Boolean(request.reversible),
        requested_by: request.requested_by, requested_at: request.requested_at, expires_at: request.expires_at, nonce: request.nonce,
      }) : undefined;
    if (this.commandRevoked(String(request.request_id), String(request.command_digest))) {
      throw new JarvisError(companyV2 ? "COMPANY_APPROVAL_REVOKED" : "CONTROL_APPROVAL_REVOKED");
    }
    if (companyV2) assertCurrentCompanyPin(this.authority, companyV2, receipt, now);
    if (request.state !== "pending" || request.command_digest !== receipt.command_digest || Date.parse(String(request.expires_at)) <= nowMs)
      throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE"); const key = this.authority.db .prepare(
        `SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k
         JOIN authority_key_purposes p ON p.key_id=k.key_id
         WHERE k.key_id=? AND p.purpose='decision'`,
      ) .get(receipt.key_id) as { public_key_pem: string; principal_id: string } | undefined; if ( !key || key.principal_id !== receipt.signer_principal_id ||
      !verifyCommandApproval(receipt, key.public_key_pem, now, String(request.action)) || Date.parse(receipt.expires_at) > Date.parse(String(request.expires_at)) )
      throw new JarvisError(companyV2 ? "COMPANY_APPROVAL_INVALID" : "CONTROL_APPROVAL_INVALID");
    const state = receipt.decision === "approve" ? "approved" : "rejected";
    const progress = new CompanyProgress(this.authority, this.companyFreshness);
    let reservation: CompanyProgressReservation | undefined;
    let at = now.toISOString();
    const operation = receipt.decision === "approve" ? "decide_approve" : "decide_reject";
    const token = companyV2 ? randomUUID() : undefined;
    if (companyV2 && token) {
      if (this.authority.db.inTransaction) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      this.authority.db.transaction(() => {
        reservation = progress.pending(companyV2, operation);
        if (reservation && reservation.reserve_request.event_digest !== hash(receipt)) {
          throw new JarvisError("COMPANY_APPROVAL_INVALID");
        }
        const scope = companyV2.target;
        const busy = this.authority.db.prepare(
          `SELECT 1 FROM company_progress_reservations
           WHERE provider_instance_id=? AND workspace_id=? AND evidence_digest IS NULL AND operation_id<>?
           UNION ALL
           SELECT 1 FROM company_candidate_handoffs h JOIN control_command_requests r USING(request_id)
           WHERE json_extract(r.target_json,'$.provider_instance_id')=? AND json_extract(r.target_json,'$.workspace_id')=?
           AND h.lease_token IS NOT NULL AND h.lease_expires_at>? LIMIT 1`,
        ).get(scope.provider_instance_id, scope.workspace_id, reservation?.operation_id ?? "",
          scope.provider_instance_id, scope.workspace_id, at);
        if (busy) throw new JarvisError("COMPANY_EXECUTION_BUSY");
        assertCurrentCompanyPin(this.authority, companyV2, receipt, now);
        const changed = this.authority.db.prepare(
          `UPDATE company_candidate_handoffs SET lease_token=?,lease_expires_at=?,updated_at=?
           WHERE request_id=? AND current=1 AND command_digest=?
           AND EXISTS (SELECT 1 FROM control_command_requests r WHERE r.request_id=company_candidate_handoffs.request_id AND r.state='pending')
           AND (lease_token IS NULL OR lease_expires_at<=?)`,
        ).run(token, new Date(nowMs + 60_000).toISOString(), at, receipt.request_id, receipt.command_digest, at);
        if (changed.changes !== 1) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
      }).immediate();
    }
    try {
    if (companyV2) {
      // The local claim is committed before provider I/O; a receipt rollback must retain this reservation.
      reservation ??= progress.reserve(companyV2, operation, hash(receipt), now);
    }
    now = readNow();
    at = now.toISOString();
    const tx = this.authority.db.transaction(() => {
      if (request.action === "company.candidate.transition") {
        const imported = this.authority.db.prepare(
          "SELECT current,command_digest FROM company_candidate_handoffs WHERE request_id=?",
        ).get(receipt.request_id) as { current: number; command_digest: string } | undefined;
        if (!imported || imported.current !== 1 || imported.command_digest !== receipt.command_digest) {
          throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
        }
        if (companyV2) {
          const current = this.get(receipt.request_id);
          const currentKey = this.authority.db.prepare(
            `SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k
             JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=? AND p.purpose='decision'`,
          ).get(receipt.key_id) as { public_key_pem: string; principal_id: string } | undefined;
          if (!current || current.state !== "pending" || current.command_digest !== receipt.command_digest
            || Date.parse(current.expires_at) <= now.getTime()) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
          if (this.commandRevoked(current.request_id, current.command_digest, receipt.receipt_id)) {
            throw new JarvisError("COMPANY_APPROVAL_REVOKED");
          }
          if (!currentKey || currentKey.principal_id !== receipt.signer_principal_id
            || !verifyCommandApproval(receipt, currentKey.public_key_pem, now, current.action)) throw new JarvisError("COMPANY_APPROVAL_INVALID");
          assertCurrentCompanyPin(this.authority, companyV2, receipt, now);
          if (reservation) progress.assertReservation(reservation);
          const claim = this.authority.db.prepare(
            "SELECT 1 FROM company_candidate_handoffs WHERE request_id=? AND lease_token=?",
          ).get(receipt.request_id, token);
          if (!claim) throw new JarvisError("CONTROL_APPROVAL_RACE");
        } else {
          const target = JSON.parse(String(request.target_json)) as { provider_instance_id: string; workspace_id: string };
          if (readCompanyApprovalBinding(this.authority, target)) throw new JarvisError("ENROLLMENT_REQUIRED");
          const args = companyArgumentsSchema.parse(JSON.parse(String(request.args_json)));
          if (this.legacyRevoked(receipt.key_id, receipt.signer_principal_id)) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
          if (receipt.signer_principal_id !== args.owner || receipt.signer_principal_id === args.processor_principal_id) {
            throw new JarvisError("CONTROL_APPROVAL_INVALID");
          }
        }
      }
      if (request.action === "memory.scope.review" && receipt.decision === "approve") {
        const action = this.parseStoredAction(request); validateControlAction(action);
        validateMemoryCandidateScopeProposal(this.authority, action.args.proposal, now);
        if (receipt.signer_principal_id !== "principal:owner") throw new JarvisError("CONTROL_APPROVAL_INVALID");
      }
      this.authority.db .prepare(
          `INSERT INTO control_command_receipts(
            receipt_id,request_id,decision,command_digest,signer_principal_id,
            authenticated_session_id,key_id,payload_json,signature,issued_at,expires_at,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        ) .run( receipt.receipt_id, receipt.request_id, receipt.decision, receipt.command_digest, receipt.signer_principal_id, receipt.authenticated_session_id,
          receipt.key_id, canonicalize(receipt), receipt.signature, receipt.issued_at, receipt.expires_at, at, ); const changed = this.authority.db
        .prepare("UPDATE control_command_requests SET state=? WHERE request_id=? AND state='pending'") .run(state, receipt.request_id);
      if (changed.changes !== 1) throw new JarvisError("CONTROL_APPROVAL_RACE");
      if (companyV2) stageCompanyProgressEvidence(this.authority, {
        kind: "jarvis_decision", original_at: at, command: companyV2, receipt,
      });
      new MemorySurfaceAuthority(this.authority).applyReceipt(receipt, receipt.request_id, now); this.event({ event_id: `evt:${receipt.request_id}:${state}`,
        event_type: `control.command.${state}`, source: "human-approval", subject: receipt.request_id, correlation_id: receipt.request_id,
        causation_id: `evt:${receipt.request_id}:requested`, payload: { receipt_id: receipt.receipt_id, signer_principal_id: receipt.signer_principal_id },
        created_at: at, }); }); tx();
    if (reservation) {
      try { progress.finish(reservation, hash(receipt), state, now); }
      catch (error) {
        const code = error instanceof JarvisError ? error.code : "COMPANY_PROGRESS_UNCERTAIN";
        this.authority.db.prepare(
          "UPDATE company_candidate_handoffs SET status='uncertain',failure_code=?,updated_at=? WHERE request_id=?",
        ).run(code, at, receipt.request_id);
        throw error;
      }
    }
    } finally {
      if (token) this.authority.db.prepare(
        "UPDATE company_candidate_handoffs SET lease_token=NULL,lease_expires_at=NULL WHERE request_id=? AND lease_token=?",
      ).run(receipt.request_id, token);
    }
  } private authorityLossCode(row: Record<string, unknown>, nowMs: number): string | null {
    const leaseExpires = Date.parse(String(row.lease_expires_at)); const requestExpires = Date.parse(String(row.expires_at));
    const approvalExpires = Date.parse(String(row.approval_expires));
    if (!Number.isFinite(leaseExpires) || leaseExpires <= nowMs) return "CONTROL_CLAIM_EXPIRED";
    if (!Number.isFinite(requestExpires) || requestExpires <= nowMs) return "CONTROL_COMMAND_EXPIRED";
    if (!Number.isFinite(approvalExpires) || approvalExpires <= nowMs) return "CONTROL_APPROVAL_EXPIRED";
    if (this.commandRevoked(String(row.request_id), String(row.command_digest), String(row.receipt_id))) return "CONTROL_APPROVAL_REVOKED"; return null; }
  private recoverClaimedAuthorityLoss(requestId: string, fence: number, at: string, failureCode: string): boolean { const changed = this.authority.db .prepare(
        `UPDATE control_command_requests
         SET state='uncertain',failure_code=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL
         WHERE request_id=? AND state='claimed' AND lease_fence=?`,
      ) .run(failureCode, at, requestId, fence); if (changed.changes !== 1) return false; this.event({ event_id: `evt:${requestId}:authority-lost:${fence}`,
      event_type: "control.command.authority_lost", source: "jarvis-control-plane", subject: requestId, correlation_id: requestId,
      causation_id: `evt:${requestId}:claimed:${fence}`, payload: { fence, failure_code: failureCode }, created_at: at, }); return true; }
  recoverExpired(now = new Date()): number { const nowMs = finiteDate(now, "CONTROL_RECOVERY_INVALID"); const at = now.toISOString(); let recovered = 0;
    const rows = this.authority.db .prepare(
        `SELECT r.*,x.receipt_id,a.expires_at AS approval_expires
         FROM control_command_requests r
         JOIN control_command_redemptions x
           ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
         JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
         WHERE r.state='claimed' ORDER BY r.requested_at,r.request_id`,
      ) .all() as Array<Record<string, unknown>>; for (const row of rows) { const loss = this.authorityLossCode(row, nowMs);
      if (loss && this.recoverClaimedAuthorityLoss(String(row.request_id), Number(row.lease_fence), at, loss)) recovered++; } return recovered; }
  nextApproved(now = new Date(), excludedActions: readonly string[] = []): string | null {
    const nowMs = finiteDate(now, "CONTROL_QUEUE_INVALID"); const rows = this.authority.db .prepare(
        `SELECT r.request_id,r.action,r.command_digest,r.expires_at,a.receipt_id,
           a.expires_at AS approval_expires
         FROM control_command_requests r
         JOIN control_command_receipts a
           ON a.request_id=r.request_id AND a.decision='approve'
         LEFT JOIN control_command_redemptions x ON x.request_id=r.request_id
         WHERE r.state='approved' AND x.request_id IS NULL
           AND r.action <> 'memory.scope.review'
           AND r.action <> 'company.candidate.transition'
           AND r.action NOT IN (SELECT value FROM json_each(?))
         ORDER BY r.requested_at,r.request_id`,
      ) .all(JSON.stringify(excludedActions)) as Array<Record<string, unknown>>; for (const row of rows) {
      if (Date.parse(String(row.expires_at)) <= nowMs || Date.parse(String(row.approval_expires)) <= nowMs) continue;
      if (row.action === "task.execute" && !readControlCommand(this.authority, String(row.request_id))) continue;
      if (this.commandRevoked(String(row.request_id), String(row.command_digest), String(row.receipt_id))) continue; return String(row.request_id); }
    return null; } private expireStaleClaims(now: string): void { this.recoverExpired(new Date(now)); }
  claim(requestId: string, worker: string, now = new Date(), leaseMs = 60_000): ClaimedControlCommand { const nowMs = finiteDate(now, "CONTROL_CLAIM_INVALID");
    if (!nonempty(requestId) || !nonempty(worker) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000)
      throw new JarvisError("CONTROL_CLAIM_INVALID"); const at = now.toISOString(); let result: ClaimedControlCommand | undefined;
    const tx = this.authority.db.transaction(() => { this.expireStaleClaims(at); const row = this.authority.db .prepare(
          `SELECT r.*,a.receipt_id,a.expires_at AS approval_expires
           FROM control_command_requests r
           JOIN control_command_receipts a
             ON a.request_id=r.request_id AND a.decision='approve'
           LEFT JOIN control_command_redemptions x ON x.request_id=r.request_id
           WHERE r.request_id=? AND x.request_id IS NULL`,
        ) .get(requestId) as Record<string, unknown> | undefined;
      if (!row || row.state !== "approved" || Date.parse(String(row.expires_at)) <= nowMs || Date.parse(String(row.approval_expires)) <= nowMs)
        throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      if (row.action === "memory.scope.review") throw new JarvisError("CONTROL_ACTION_REVIEW_ONLY");
      if (row.action === "company.candidate.transition") throw new JarvisError("CONTROL_ACTION_REVIEW_ONLY");
      if (row.action === "task.execute" && !readControlCommand(this.authority, requestId)) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      if (this.commandRevoked(requestId, String(row.command_digest), String(row.receipt_id))) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
      const action = this.parseStoredAction(row); validateControlAction(action); const fence = Number(row.lease_fence) + 1;
      const leaseUntil = Math.min(nowMs + leaseMs, Date.parse(String(row.expires_at)), Date.parse(String(row.approval_expires)));
      if (!Number.isFinite(leaseUntil) || leaseUntil <= nowMs) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      const leaseExpires = new Date(leaseUntil).toISOString(); const changed = this.authority.db .prepare(
          `UPDATE control_command_requests
           SET state='claimed',lease_owner=?,lease_fence=?,lease_expires_at=?
           WHERE request_id=? AND state='approved' AND lease_fence=?`,
        ) .run(worker, fence, leaseExpires, requestId, row.lease_fence); if (changed.changes !== 1) throw new JarvisError("CONTROL_CLAIM_RACE");
      this.authority.db .prepare("INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,?,?)")
        .run(row.receipt_id, requestId, fence, at); this.event({ event_id: `evt:${requestId}:claimed:${fence}`, event_type: "control.command.claimed",
        source: worker, subject: requestId, correlation_id: requestId, causation_id: `evt:${requestId}:approved`,
        payload: { receipt_id: row.receipt_id, fence, lease_expires_at: leaseExpires }, created_at: at, }); result = { request_id: requestId,
        receipt_id: String(row.receipt_id), action: action.action, action_level: action.action_level, target: action.target, args: action.args,
        command_digest: String(row.command_digest), reversible: Boolean(row.reversible), fence, lease_expires_at: leaseExpires, }; });
    runImmediate(tx, "CONTROL_CLAIM_RACE");
    if (!result) throw new JarvisError("CONTROL_CLAIM_FAILED"); return result; } settle( requestId: string, fence: number,
    outcome: { state: "completed" | "failed" | "uncertain"; effect_type: string; payload: unknown; failure_code?: string }, now = new Date(), ): void {
    const nowMs = finiteDate(now, "CONTROL_SETTLE_INVALID");
    if (!nonempty(requestId) || !Number.isSafeInteger(fence) || fence < 1 || !validOutcomeStates.has(outcome.state) || !nonempty(outcome.effect_type))
      throw new JarvisError("CONTROL_SETTLE_INVALID"); const at = now.toISOString(); let staleError: string | undefined;
    const tx = this.authority.db.transaction(() => { const row = this.authority.db .prepare(
          `SELECT r.*,x.receipt_id,a.expires_at AS approval_expires
           FROM control_command_requests r
           LEFT JOIN control_command_redemptions x
             ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
           LEFT JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
           WHERE r.request_id=?`,
        ) .get(requestId) as Record<string, unknown> | undefined;
      if (!row || row.state !== "claimed" || Number(row.lease_fence) !== fence || !nonempty(row.receipt_id)) throw new JarvisError("CONTROL_STALE_FENCE");
      const loss = this.authorityLossCode(row, nowMs); if (loss) { this.recoverClaimedAuthorityLoss(requestId, fence, at, loss);
        staleError = loss === "CONTROL_APPROVAL_REVOKED" ? "CONTROL_APPROVAL_REVOKED" : "CONTROL_STALE_FENCE"; return; }
      const payloadJson = canonicalize(outcome.payload); const payloadDigest = hash(payloadJson);
      const effectId = `effect:${hash({ requestId, fence, outcome: outcome.state, payload: outcome.payload }).slice(7)}`; this.authority.db
        .prepare("INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)")
        .run(effectId, requestId, outcome.effect_type, payloadJson, payloadDigest, at); const changed = this.authority.db .prepare(
          `UPDATE control_command_requests
           SET state=?,completed_at=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL
           WHERE request_id=? AND state='claimed' AND lease_fence=?`,
        ) .run(outcome.state, at, outcome.failure_code ?? null, requestId, fence); if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
      this.event({ event_id: `evt:${requestId}:${outcome.state}:${fence}`, event_type: `control.command.${outcome.state}`, source: "jarvis-control-plane",
        subject: requestId, correlation_id: requestId, causation_id: `evt:${requestId}:claimed:${fence}`,
        payload: { effect_id: effectId, failure_code: outcome.failure_code ?? null }, created_at: at, }); }); tx();
    if (staleError) throw new JarvisError(staleError); } cancel(input: ControlCancelInput, now = new Date()): void {
    const nowMs = finiteDate(now, "CONTROL_CANCEL_INVALID"); const actor = input.actor ?? input.revoked_by; const revokedAtMs = finiteIso(input.revoked_at);
    if ( !nonempty(input.request_id) || !nonempty(input.reason) || !nonempty(actor) ||
      (input.actor !== undefined && input.revoked_by !== undefined && input.actor !== input.revoked_by) || !Number.isFinite(revokedAtMs) || revokedAtMs > nowMs
    ) throw new JarvisError("CONTROL_CANCEL_INVALID");
    const normalized = { request_id: input.request_id, reason: input.reason, revoked_by: actor, revoked_at: input.revoked_at };
    const payloadJson = canonicalize(normalized); const payloadDigest = hash(payloadJson);
    const revocationId = `control-revocation:${hash(normalized).slice(7)}`; const eventId = `evt:${input.request_id}:cancelled`;
    const tx = this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare("SELECT payload_digest FROM control_command_revocations WHERE request_id=?").get(input.request_id) as
        | { payload_digest: string } | undefined; if (prior) {
        const event = this.authority.db.prepare("SELECT 1 FROM control_events WHERE event_id=?").get(eventId);
        if (prior.payload_digest === payloadDigest && event) return; throw new JarvisError("CONTROL_CANCEL_REPLAY_CONFLICT"); }
      const request = this.authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?").get(input.request_id) as | Record<string, unknown>
        | undefined; if (!request || !["pending", "approved", "claimed"].includes(String(request.state))) throw new JarvisError("CONTROL_CANCEL_NOT_AVAILABLE");
      const receipt = this.authority.db .prepare("SELECT receipt_id FROM control_command_receipts WHERE request_id=? AND decision='approve'")
        .get(input.request_id) as { receipt_id: string } | undefined; this.authority.db .prepare(
          `INSERT INTO control_command_revocations(
            revocation_id,request_id,receipt_id,command_digest,reason,revoked_by,revoked_at,
            payload_json,payload_digest,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ) .run( revocationId, input.request_id, receipt?.receipt_id ?? null, request.command_digest, input.reason, actor, input.revoked_at, payloadJson,
          payloadDigest, now.toISOString(), ); const previous = String(request.state); const next = previous === "claimed" ? "uncertain" : "cancelled";
      const failureCode = previous === "claimed" ? "CONTROL_CANCELLED_UNCERTAIN" : "CONTROL_CANCELLED"; const changed = this.authority.db .prepare(
          "UPDATE control_command_requests SET state=?,completed_at=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state=?", )
        .run(next, input.revoked_at, failureCode, input.request_id, previous); if (changed.changes !== 1) throw new JarvisError("CONTROL_CANCEL_RACE");
      const causation = previous === "claimed" ? `evt:${input.request_id}:claimed:${Number(request.lease_fence)}` : previous === "pending"
            ? `evt:${input.request_id}:requested` : `evt:${input.request_id}:${previous}`; this.event({ event_id: eventId,
        event_type: previous === "claimed" ? "control.command.cancelled_uncertain" : "control.command.cancelled", source: actor, subject: input.request_id,
        correlation_id: input.request_id, causation_id: causation,
        payload: { revocation_id: revocationId, receipt_id: receipt?.receipt_id ?? null, previous_state: previous, state: next, reason: input.reason },
        created_at: input.revoked_at, }); }); tx(); }
  /** Project a proven past memory outcome. No lease, approval or write is issued. */
  reconcileMemoryOutbox(outboxId: string, now = new Date()): boolean {
    const nowMs = finiteDate(now, "CONTROL_SETTLE_INVALID");
    return this.authority.db.transaction(() => {
      const row = this.authority.db.prepare(
        `SELECT r.*,o.action_receipt_id FROM control_command_requests r
         JOIN memory_outbox o ON o.action_request_id=r.request_id WHERE o.outbox_id=?`,
      ).get(outboxId) as Record<string, unknown> | undefined;
      if (row === undefined || !["claimed", "uncertain"].includes(String(row.state))) return false;
      // The initial executor owns a live claim and will settle it itself.
      if (row.state === "claimed" && (!Number.isFinite(Date.parse(String(row.lease_expires_at)))
        || Date.parse(String(row.lease_expires_at)) > nowMs)) return false;
      const command = decodeStoredControlCommand(row); const fence = Number(row.lease_fence);
      if (this.commandRevoked(command.request_id, command.command_digest, String(row.action_receipt_id))) return false;
      const proof = memoryOutboxControlProof(this.authority, outboxId, command, fence);
      if (Date.parse(proof.observed_at) > nowMs) throw new JarvisError("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID");
      const payload = { ...proof.payload, receipt_id: proof.receipt_id, fence, observed_at: proof.observed_at };
      const payloadJson = canonicalize(payload); const at = now.toISOString();
      const effectId = `effect:${hash({ requestId: command.request_id, fence, outcome: proof.outcome, payload }).slice(7)}`;
      this.authority.db.prepare(
        "INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)",
      ).run(effectId, command.request_id, "memory.outbox.reconciled", payloadJson, hash(payloadJson), at);
      const changed = this.authority.db.prepare(
        `UPDATE control_command_requests SET state=?,completed_at=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL
         WHERE request_id=? AND state=? AND lease_fence=?`,
      ).run(proof.outcome, at, proof.failure_code, command.request_id, row.state, fence);
      if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
      this.event({ event_id: `evt:${command.request_id}:${proof.outcome}:${fence}`,
        event_type: `control.command.${proof.outcome}`, source: "jarvis-memory-outbox",
        subject: command.request_id, correlation_id: command.request_id,
        causation_id: proof.payload.terminal_event_id,
        payload: { effect_id: effectId, failure_code: proof.failure_code }, created_at: at });
      return true;
    }).immediate();
  }

  get(requestId: string): StoredControlCommand | undefined {
    return readControlCommand(this.authority, requestId);
  }

  list(): StoredControlCommand[] {
    return listControlCommands(this.authority);
  }

}
