import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { base64url, unbase64url } from "./receipt.js";
import { validateControlAction } from "./control-actions.js";

export type ActionLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type ControlCommandState = "pending" | "approved" | "rejected" | "claimed" | "completed" | "failed" | "uncertain" | "cancelled";

export interface ControlCommandRequestInput {
  schema_version: 1;
  request_id: string;
  action: string;
  action_level: ActionLevel;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
  reversible: boolean;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  nonce: string;
}

export interface StoredControlCommand extends ControlCommandRequestInput {
  command_digest: string;
  state: ControlCommandState;
}

export interface CommandApprovalReceipt {
  schema_version: 1;
  receipt_id: string;
  request_id: string;
  decision: "approve" | "reject";
  command_digest: string;
  signer_principal_id: string;
  authenticated_session_id: string;
  key_id: string;
  algorithm: "Ed25519";
  issued_at: string;
  not_before: string;
  expires_at: string;
  nonce: string;
  max_uses: 1;
  status: "issued";
  signature: string;
}

export interface ClaimedControlCommand {
  request_id: string;
  receipt_id: string;
  action: string;
  action_level: ActionLevel;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
  command_digest: string;
  reversible: boolean;
  fence: number;
  lease_expires_at: string;
}

export interface ControlCancelInput {
  request_id: string;
  reason: string;
  actor?: string;
  revoked_by?: string;
  revoked_at: string;
}

export interface ControlEventInput {
  event_id: string;
  event_type: string;
  source: string;
  subject: string;
  correlation_id?: string;
  causation_id?: string;
  payload: unknown;
  created_at?: string;
}

export const COMMAND_APPROVAL_DOMAIN = "orca-jarvis/command-approval/v1\u0000";
const hash = (value: unknown) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex")}`;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const receiptPayload = (receipt: CommandApprovalReceipt): Omit<CommandApprovalReceipt, "signature"> => { const { signature, ...payload } = receipt; void signature; return payload; };
const validOutcomeStates = new Set(["completed", "failed", "uncertain"]);

function finiteDate(date: Date, code: string): number {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new JarvisError(code);
  return time;
}

function finiteIso(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NaN;
}

export function controlCommandDigest(input: ControlCommandRequestInput): string {
  return hash({ schema_version: input.schema_version, request_id: input.request_id, action: input.action, action_level: input.action_level, target: input.target, args: input.args, reversible: input.reversible, requested_by: input.requested_by, requested_at: input.requested_at, expires_at: input.expires_at, nonce: input.nonce });
}

export function signCommandApproval(payload: Omit<CommandApprovalReceipt, "signature">, key: KeyObject): CommandApprovalReceipt {
  return { ...payload, signature: base64url(sign(null, Buffer.from(COMMAND_APPROVAL_DOMAIN + canonicalize(payload)), key)) };
}

export function verifyCommandApproval(receipt: CommandApprovalReceipt, trustedPublicKey: string, now: Date): boolean {
  const issued = Date.parse(receipt.issued_at); const notBefore = Date.parse(receipt.not_before); const expires = Date.parse(receipt.expires_at);
  if (receipt.schema_version !== 1 || !nonempty(receipt.receipt_id) || !nonempty(receipt.request_id) || !nonempty(receipt.command_digest) || !nonempty(receipt.signer_principal_id) || !nonempty(receipt.authenticated_session_id) || !nonempty(receipt.key_id) || receipt.algorithm !== "Ed25519" || receipt.max_uses !== 1 || receipt.status !== "issued" || !nonempty(receipt.nonce) || !Number.isFinite(issued) || !Number.isFinite(notBefore) || !Number.isFinite(expires) || issued > now.getTime() || notBefore > now.getTime() || expires <= issued || expires <= now.getTime() || expires - issued > 15 * 60_000) return false;
  try { return verify(null, Buffer.from(COMMAND_APPROVAL_DOMAIN + canonicalize(receiptPayload(receipt))), trustedPublicKey, unbase64url(receipt.signature)); } catch { return false; }
}

export class ControlPlane {
  constructor(private readonly authority: AuthorityDb) {}

  private event(input: ControlEventInput): void {
    const created = input.created_at ?? new Date().toISOString(); const payloadJson = canonicalize(input.payload);
    this.authority.db.prepare("INSERT INTO control_events(event_id,schema_version,event_type,source,subject,correlation_id,causation_id,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(input.event_id, 1, input.event_type, input.source, input.subject, input.correlation_id ?? null, input.causation_id ?? null, payloadJson, hash(payloadJson), created);
  }

  emit(input: ControlEventInput): void { this.event(input); }

  private legacyRevoked(...references: Array<string | undefined>): boolean {
    const unique = [...new Set(references.filter(nonempty))];
    return unique.some(reference => Boolean(this.authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(reference)));
  }

  private controlRevoked(requestId: string, receiptId?: string): boolean {
    if (receiptId) return Boolean(this.authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?").get(requestId, receiptId));
    return Boolean(this.authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=?").get(requestId));
  }

  private commandRevoked(requestId: string, commandDigest: string, receiptId?: string): boolean {
    return this.controlRevoked(requestId, receiptId) || this.legacyRevoked(requestId, commandDigest, receiptId);
  }

  private parseStoredAction(row: Record<string, unknown>): { action: string; action_level: ActionLevel; target: Record<string, unknown>; args: Record<string, unknown> } {
    const target = JSON.parse(String(row.target_json)) as unknown; const args = JSON.parse(String(row.args_json)) as unknown;
    if (!isRecord(target) || !isRecord(args)) throw new JarvisError("CONTROL_COMMAND_INVALID");
    return { action: String(row.action), action_level: Number(row.action_level) as ActionLevel, target, args };
  }

  stage(input: ControlCommandRequestInput, now = new Date()): StoredControlCommand {
    const nowMs = finiteDate(now, "CONTROL_COMMAND_INVALID"); const requested = finiteIso(input.requested_at); const expires = finiteIso(input.expires_at);
    if (input.schema_version !== 1 || !nonempty(input.request_id) || !nonempty(input.action) || !Number.isInteger(input.action_level) || input.action_level < 0 || input.action_level > 5 || !isRecord(input.target) || !isRecord(input.args) || typeof input.reversible !== "boolean" || !nonempty(input.requested_by) || !nonempty(input.nonce) || !Number.isFinite(requested) || !Number.isFinite(expires) || requested > nowMs || expires <= nowMs || expires <= requested || expires - requested > 24 * 60 * 60_000) throw new JarvisError("CONTROL_COMMAND_INVALID");
    validateControlAction(input);
    if (["memory.correct", "memory.export", "memory.forget", "memory.generation.rollback"].includes(input.action)
      && input.reversible) throw new JarvisError("CONTROL_COMMAND_INVALID");
    const digest = controlCommandDigest(input); const targetJson = canonicalize(input.target); const argsJson = canonicalize(input.args); const at = now.toISOString();
    const prior = this.authority.db.prepare("SELECT command_digest,state FROM control_command_requests WHERE request_id=?").get(input.request_id) as { command_digest: string; state: ControlCommandState } | undefined;
    if (prior) { if (prior.command_digest !== digest) throw new JarvisError("CONTROL_COMMAND_REPLAY_CONFLICT"); return { ...input, command_digest: digest, state: prior.state }; }
    const tx = this.authority.db.transaction(() => {
      this.authority.db.prepare("INSERT INTO control_command_requests(request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.request_id, input.action, input.action_level, targetJson, argsJson, digest, input.reversible ? 1 : 0, input.requested_by, input.requested_at, input.expires_at, input.nonce, "pending", at);
      this.event({ event_id: `evt:${input.request_id}:requested`, event_type: "control.command.requested", source: "jarvis-control-plane", subject: input.request_id, correlation_id: input.request_id, payload: { action: input.action, action_level: input.action_level, command_digest: digest }, created_at: at });
    }); tx();
    return { ...input, command_digest: digest, state: "pending" };
  }

  decide(receipt: CommandApprovalReceipt, now = new Date()): void {
    const nowMs = finiteDate(now, "CONTROL_APPROVAL_INVALID");
    const request = this.authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?").get(receipt.request_id) as Record<string, unknown> | undefined;
    if (!request) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
    if (this.commandRevoked(String(request.request_id), String(request.command_digest))) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
    if (request.state !== "pending" || request.command_digest !== receipt.command_digest || Date.parse(String(request.expires_at)) <= nowMs) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
    const key = this.authority.db.prepare("SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=? AND p.purpose='decision'").get(receipt.key_id) as { public_key_pem: string; principal_id: string } | undefined;
    if (!key || key.principal_id !== receipt.signer_principal_id || !verifyCommandApproval(receipt, key.public_key_pem, now) || Date.parse(receipt.expires_at) > Date.parse(String(request.expires_at))) throw new JarvisError("CONTROL_APPROVAL_INVALID");
    const state = receipt.decision === "approve" ? "approved" : "rejected";
    const at = now.toISOString();
    const tx = this.authority.db.transaction(() => {
      this.authority.db.prepare("INSERT INTO control_command_receipts(receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,payload_json,signature,issued_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(receipt.receipt_id, receipt.request_id, receipt.decision, receipt.command_digest, receipt.signer_principal_id, receipt.authenticated_session_id, receipt.key_id, canonicalize(receipt), receipt.signature, receipt.issued_at, receipt.expires_at, at);
      const changed = this.authority.db.prepare("UPDATE control_command_requests SET state=? WHERE request_id=? AND state='pending'").run(state, receipt.request_id); if (changed.changes !== 1) throw new JarvisError("CONTROL_APPROVAL_RACE");
      this.event({ event_id: `evt:${receipt.request_id}:${state}`, event_type: `control.command.${state}`, source: "human-approval", subject: receipt.request_id, correlation_id: receipt.request_id, causation_id: `evt:${receipt.request_id}:requested`, payload: { receipt_id: receipt.receipt_id, signer_principal_id: receipt.signer_principal_id }, created_at: at });
    }); tx();
  }

  private authorityLossCode(row: Record<string, unknown>, nowMs: number): string | null {
    const leaseExpires = Date.parse(String(row.lease_expires_at)); const requestExpires = Date.parse(String(row.expires_at)); const approvalExpires = Date.parse(String(row.approval_expires));
    if (!Number.isFinite(leaseExpires) || leaseExpires <= nowMs) return "CONTROL_CLAIM_EXPIRED";
    if (!Number.isFinite(requestExpires) || requestExpires <= nowMs) return "CONTROL_COMMAND_EXPIRED";
    if (!Number.isFinite(approvalExpires) || approvalExpires <= nowMs) return "CONTROL_APPROVAL_EXPIRED";
    if (this.commandRevoked(String(row.request_id), String(row.command_digest), String(row.receipt_id))) return "CONTROL_APPROVAL_REVOKED";
    return null;
  }

  private recoverClaimedAuthorityLoss(requestId: string, fence: number, at: string, failureCode: string): boolean {
    const changed = this.authority.db.prepare("UPDATE control_command_requests SET state='uncertain',failure_code=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state='claimed' AND lease_fence=?").run(failureCode, at, requestId, fence);
    if (changed.changes !== 1) return false;
    this.event({ event_id: `evt:${requestId}:authority-lost:${fence}`, event_type: "control.command.authority_lost", source: "jarvis-control-plane", subject: requestId, correlation_id: requestId, causation_id: `evt:${requestId}:claimed:${fence}`, payload: { fence, failure_code: failureCode }, created_at: at });
    return true;
  }

  recoverExpired(now = new Date()): number {
    const nowMs = finiteDate(now, "CONTROL_RECOVERY_INVALID"); const at = now.toISOString(); let recovered = 0;
    const rows = this.authority.db.prepare("SELECT r.*,x.receipt_id,a.expires_at AS approval_expires FROM control_command_requests r JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence JOIN control_command_receipts a ON a.receipt_id=x.receipt_id WHERE r.state='claimed' ORDER BY r.requested_at,r.request_id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const loss = this.authorityLossCode(row, nowMs);
      if (loss && this.recoverClaimedAuthorityLoss(String(row.request_id), Number(row.lease_fence), at, loss)) recovered++;
    }
    return recovered;
  }

  nextApproved(now = new Date()): string | null {
    const nowMs = finiteDate(now, "CONTROL_QUEUE_INVALID");
    const rows = this.authority.db.prepare("SELECT r.request_id,r.command_digest,r.expires_at,a.receipt_id,a.expires_at AS approval_expires FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve' LEFT JOIN control_command_redemptions x ON x.request_id=r.request_id WHERE r.state='approved' AND x.request_id IS NULL ORDER BY r.requested_at,r.request_id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (Date.parse(String(row.expires_at)) <= nowMs || Date.parse(String(row.approval_expires)) <= nowMs) continue;
      if (this.commandRevoked(String(row.request_id), String(row.command_digest), String(row.receipt_id))) continue;
      return String(row.request_id);
    }
    return null;
  }

  private expireStaleClaims(now: string): void { this.recoverExpired(new Date(now)); }

  claim(requestId: string, worker: string, now = new Date(), leaseMs = 60_000): ClaimedControlCommand {
    const nowMs = finiteDate(now, "CONTROL_CLAIM_INVALID");
    if (!nonempty(requestId) || !nonempty(worker) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000) throw new JarvisError("CONTROL_CLAIM_INVALID");
    const at = now.toISOString(); let result: ClaimedControlCommand | undefined;
    const tx = this.authority.db.transaction(() => {
      this.expireStaleClaims(at);
      const row = this.authority.db.prepare("SELECT r.*,a.receipt_id,a.expires_at AS approval_expires FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id AND a.decision='approve' LEFT JOIN control_command_redemptions x ON x.request_id=r.request_id WHERE r.request_id=? AND x.request_id IS NULL").get(requestId) as Record<string, unknown> | undefined;
      if (!row || row.state !== "approved" || Date.parse(String(row.expires_at)) <= nowMs || Date.parse(String(row.approval_expires)) <= nowMs) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      if (this.commandRevoked(requestId, String(row.command_digest), String(row.receipt_id))) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
      const action = this.parseStoredAction(row); validateControlAction(action);
      const fence = Number(row.lease_fence) + 1; const leaseUntil = Math.min(nowMs + leaseMs, Date.parse(String(row.expires_at)), Date.parse(String(row.approval_expires)));
      if (!Number.isFinite(leaseUntil) || leaseUntil <= nowMs) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      const leaseExpires = new Date(leaseUntil).toISOString();
      const changed = this.authority.db.prepare("UPDATE control_command_requests SET state='claimed',lease_owner=?,lease_fence=?,lease_expires_at=? WHERE request_id=? AND state='approved' AND lease_fence=?").run(worker, fence, leaseExpires, requestId, row.lease_fence); if (changed.changes !== 1) throw new JarvisError("CONTROL_CLAIM_RACE");
      this.authority.db.prepare("INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,?,?)").run(row.receipt_id, requestId, fence, at);
      this.event({ event_id: `evt:${requestId}:claimed:${fence}`, event_type: "control.command.claimed", source: worker, subject: requestId, correlation_id: requestId, causation_id: `evt:${requestId}:approved`, payload: { receipt_id: row.receipt_id, fence, lease_expires_at: leaseExpires }, created_at: at });
      result = { request_id: requestId, receipt_id: String(row.receipt_id), action: action.action, action_level: action.action_level, target: action.target, args: action.args, command_digest: String(row.command_digest), reversible: Boolean(row.reversible), fence, lease_expires_at: leaseExpires };
    }); tx();
    if (!result) throw new JarvisError("CONTROL_CLAIM_FAILED"); return result;
  }

  settle(requestId: string, fence: number, outcome: { state: "completed" | "failed" | "uncertain"; effect_type: string; payload: unknown; failure_code?: string }, now = new Date()): void {
    const nowMs = finiteDate(now, "CONTROL_SETTLE_INVALID");
    if (!nonempty(requestId) || !Number.isSafeInteger(fence) || fence < 1 || !validOutcomeStates.has(outcome.state) || !nonempty(outcome.effect_type)) throw new JarvisError("CONTROL_SETTLE_INVALID");
    const at = now.toISOString(); let staleError: string | undefined;
    const tx = this.authority.db.transaction(() => {
      const row = this.authority.db.prepare("SELECT r.*,x.receipt_id,a.expires_at AS approval_expires FROM control_command_requests r LEFT JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence LEFT JOIN control_command_receipts a ON a.receipt_id=x.receipt_id WHERE r.request_id=?").get(requestId) as Record<string, unknown> | undefined;
      if (!row || row.state !== "claimed" || Number(row.lease_fence) !== fence || !nonempty(row.receipt_id)) throw new JarvisError("CONTROL_STALE_FENCE");
      const loss = this.authorityLossCode(row, nowMs);
      if (loss) { this.recoverClaimedAuthorityLoss(requestId, fence, at, loss); staleError = loss === "CONTROL_APPROVAL_REVOKED" ? "CONTROL_APPROVAL_REVOKED" : "CONTROL_STALE_FENCE"; return; }
      const payloadJson = canonicalize(outcome.payload); const payloadDigest = hash(payloadJson); const effectId = `effect:${hash({ requestId, fence, outcome: outcome.state, payload: outcome.payload }).slice(7)}`;
      this.authority.db.prepare("INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?)").run(effectId, requestId, outcome.effect_type, payloadJson, payloadDigest, at);
      const changed = this.authority.db.prepare("UPDATE control_command_requests SET state=?,completed_at=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state='claimed' AND lease_fence=?").run(outcome.state, at, outcome.failure_code ?? null, requestId, fence); if (changed.changes !== 1) throw new JarvisError("CONTROL_STALE_FENCE");
      this.event({ event_id: `evt:${requestId}:${outcome.state}:${fence}`, event_type: `control.command.${outcome.state}`, source: "jarvis-control-plane", subject: requestId, correlation_id: requestId, causation_id: `evt:${requestId}:claimed:${fence}`, payload: { effect_id: effectId, failure_code: outcome.failure_code ?? null }, created_at: at });
    }); tx(); if (staleError) throw new JarvisError(staleError);
  }

  cancel(input: ControlCancelInput, now = new Date()): void {
    const nowMs = finiteDate(now, "CONTROL_CANCEL_INVALID"); const actor = input.actor ?? input.revoked_by; const revokedAtMs = finiteIso(input.revoked_at);
    if (!nonempty(input.request_id) || !nonempty(input.reason) || !nonempty(actor) || (input.actor !== undefined && input.revoked_by !== undefined && input.actor !== input.revoked_by) || !Number.isFinite(revokedAtMs) || revokedAtMs > nowMs) throw new JarvisError("CONTROL_CANCEL_INVALID");
    const normalized = { request_id: input.request_id, reason: input.reason, revoked_by: actor, revoked_at: input.revoked_at }; const payloadJson = canonicalize(normalized); const payloadDigest = hash(payloadJson); const revocationId = `control-revocation:${hash(normalized).slice(7)}`; const eventId = `evt:${input.request_id}:cancelled`;
    const tx = this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare("SELECT payload_digest FROM control_command_revocations WHERE request_id=?").get(input.request_id) as { payload_digest: string } | undefined;
      if (prior) {
        const event = this.authority.db.prepare("SELECT 1 FROM control_events WHERE event_id=?").get(eventId);
        if (prior.payload_digest === payloadDigest && event) return;
        throw new JarvisError("CONTROL_CANCEL_REPLAY_CONFLICT");
      }
      const request = this.authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?").get(input.request_id) as Record<string, unknown> | undefined;
      if (!request || !["pending", "approved", "claimed"].includes(String(request.state))) throw new JarvisError("CONTROL_CANCEL_NOT_AVAILABLE");
      const receipt = this.authority.db.prepare("SELECT receipt_id FROM control_command_receipts WHERE request_id=? AND decision='approve'").get(input.request_id) as { receipt_id: string } | undefined;
      this.authority.db.prepare("INSERT INTO control_command_revocations(revocation_id,request_id,receipt_id,command_digest,reason,revoked_by,revoked_at,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(revocationId, input.request_id, receipt?.receipt_id ?? null, request.command_digest, input.reason, actor, input.revoked_at, payloadJson, payloadDigest, now.toISOString());
      const previous = String(request.state); const next = previous === "claimed" ? "uncertain" : "cancelled"; const failureCode = previous === "claimed" ? "CONTROL_CANCELLED_UNCERTAIN" : "CONTROL_CANCELLED";
      const changed = this.authority.db.prepare("UPDATE control_command_requests SET state=?,completed_at=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state=?").run(next, input.revoked_at, failureCode, input.request_id, previous); if (changed.changes !== 1) throw new JarvisError("CONTROL_CANCEL_RACE");
      const causation = previous === "claimed" ? `evt:${input.request_id}:claimed:${Number(request.lease_fence)}` : previous === "pending" ? `evt:${input.request_id}:requested` : `evt:${input.request_id}:${previous}`;
      this.event({ event_id: eventId, event_type: previous === "claimed" ? "control.command.cancelled_uncertain" : "control.command.cancelled", source: actor, subject: input.request_id, correlation_id: input.request_id, causation_id: causation, payload: { revocation_id: revocationId, receipt_id: receipt?.receipt_id ?? null, previous_state: previous, state: next, reason: input.reason }, created_at: input.revoked_at });
    }); tx();
  }

  list(): StoredControlCommand[] {
    return (this.authority.db.prepare("SELECT * FROM control_command_requests ORDER BY requested_at,request_id").all() as Array<Record<string, unknown>>).map(row => ({ schema_version: 1, request_id: String(row.request_id), action: String(row.action), action_level: Number(row.action_level) as ActionLevel, target: JSON.parse(String(row.target_json)) as Record<string, unknown>, args: JSON.parse(String(row.args_json)) as Record<string, unknown>, command_digest: String(row.command_digest), reversible: Boolean(row.reversible), requested_by: String(row.requested_by), requested_at: String(row.requested_at), expires_at: String(row.expires_at), nonce: String(row.nonce), state: String(row.state) as ControlCommandState }));
  }
}
