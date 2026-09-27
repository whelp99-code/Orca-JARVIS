import { randomBytes } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { bindingChallenge, sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";
import { parseDecisionBody } from "./remote-approval-parse.js";
import type { RemoteApprovalPolicy } from "./remote-approval-policy.js";
import { ControlReceiptSigner } from "./remote-approval-signer.js";
import { RemoteApprovalStore, type ChallengeRow } from "./remote-approval-store.js";
import {
  type RemoteApprovalBindingV1,
  type RemoteIngressContextV1,
  type RemoteIngressResolver,
} from "./remote-approval-types.js";
import { assertionAuditFlags, writeRemoteAudit } from "./remote-approval-audit.js";
import { loadEligibleRequest, translateReservedAssertion } from "./remote-approval-verify.js";

export type RemoteApprovalServiceOptions = Readonly<{
  db: AuthorityDb;
  control: ControlPlane;
  policy: { readonly owner_principal: string; readonly remote_approval: RemoteApprovalPolicy };
  origin: string;
  rpId: string;
  signer: ControlReceiptSigner;
  signerConfigured: boolean;
  resolver: RemoteIngressResolver;
}>;

export class RemoteApprovalService {
  readonly store: RemoteApprovalStore;
  readonly resolver: RemoteIngressResolver;
  private lastMs = 0;
  constructor(readonly options: RemoteApprovalServiceOptions) {
    this.store = new RemoteApprovalStore(options.db);
    this.resolver = options.resolver;
  }

  private nowIso(now: Date): string { return now.toISOString(); }
  private clock(now: Date): void {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "clock");
    if (ms < this.lastMs) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "REMOTE_CLOCK_UNSAFE");
    this.lastMs = ms;
  }

  readiness(now = new Date()): { readonly remote_ready: boolean; readonly reason: string | null } {
    const counts = this.store.quarantineCounts();
    if (counts.remote_principals_count + counts.webauthn_credentials_count + counts.webauthn_challenges_count + counts.webauthn_assertions_count !== 0) {
      return { remote_ready: false, reason: "legacy_quarantine" };
    }
    if (!this.options.signerConfigured) return { remote_ready: false, reason: "signer_unconfigured" };
    const sealed = this.store.sealedDecision(this.options.signer.keyId);
    if (!sealed) return { remote_ready: false, reason: "signer_unsealed" };
    if (sealed.principal_id !== this.options.signer.principalId || sealed.public_key_pem !== this.options.signer.spkiPem()) {
      return { remote_ready: false, reason: "signer_mismatch" };
    }
    this.clock(now);
    return { remote_ready: true, reason: null };
  }

  recover(now = new Date()): void { this.store.recoverVerifying(this.nowIso(now)); }

  requireReady(now: Date): void {
    const ready = this.readiness(now);
    if (!ready.remote_ready) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, ready.reason ?? "unready");
  }

  requireIngress(ingress: RemoteIngressContextV1, expectedPath: string, method: "GET" | "POST"): void {
    if (ingress.schema_version !== 1 || ingress.trust_mode !== "gateway" || ingress.request_method !== method || ingress.canonical_path !== expectedPath) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, "ingress");
    }
    if (ingress.public_origin !== this.options.origin) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, "origin");
  }

  ensureOwner(now: Date): { principal_id: string; user_handle: Buffer; user_handle_digest: string } {
    const existing = this.store.principal();
    if (existing) {
      if (existing.state !== "active") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "principal");
      return existing;
    }
    const userHandle = randomBytes(32);
    const row = {
      principal_id: `rpr_${randomBytes(16).toString("hex")}`,
      user_handle: userHandle,
      user_handle_digest: sha256Prefixed(userHandle),
      created_at: this.nowIso(now),
    };
    this.store.insertPrincipal(row);
    return row;
  }

  installActiveCredential(input: {
    credential_id: string; public_key_cose: Buffer; algorithm: -7 | -8; sign_count: number;
    backup_eligible: 0 | 1; backup_state: 0 | 1; now: Date;
  }): void {
    const owner = this.ensureOwner(input.now);
    const digest = sha256Prefixed(Buffer.from(input.credential_id, "base64url"));
    const keyDigest = sha256Prefixed(input.public_key_cose);
    if (this.store.tombstoneMatch(digest, keyDigest) || this.store.liveCredentialDigestMatch(digest, keyDigest)) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "duplicate");
    }
    this.store.insertCredential({
      credential_id: input.credential_id, credential_id_digest: digest, principal_id: owner.principal_id,
      public_key_cose: input.public_key_cose.toString("base64url"), public_key_digest: keyDigest,
      algorithm: input.algorithm, user_handle_digest: owner.user_handle_digest, sign_count: input.sign_count,
      counter_mode: input.sign_count === 0 ? "zero" : "monotonic", backup_eligible: input.backup_eligible,
      backup_state: input.backup_state, state: "active", transports_json: "[]", created_at: this.nowIso(input.now),
      pending_expires_at: null,
    });
  }

  projectRequest(requestId: string, ingress: RemoteIngressContextV1, now: Date): Record<string, unknown> {
    this.requireReady(now);
    this.requireIngress(ingress, `/api/v1/remote-approvals/${requestId}`, "GET");
    const request = loadEligibleRequest(this.store, requestId, now);
    return {
      schema_version: 1, request_id: requestId, action: request.action, action_level: request.action_level,
      reversible: Boolean(request.reversible), target: request.target, args: request.args,
      command_digest: request.command_digest, target_digest: request.target_digest, args_digest: request.args_digest,
      requested_at: request.requested_at, expires_at: request.expires_at, status: request.state,
    };
  }

  issueOptions(requestId: string, body: unknown, ingress: RemoteIngressContextV1, now: Date): { challenge_id: string; options: Record<string, unknown> } {
    this.requireReady(now);
    this.requireIngress(ingress, `/api/v1/remote-approvals/${requestId}/options`, "POST");
    const decision = parseDecisionBody(body);
    const at = this.nowIso(now);
    let challenge: ChallengeRow | undefined;
    const tx = this.options.db.db.transaction(() => {
      this.store.expireChallenges(at);
      const existing = this.store.liveChallenge(requestId, decision, ingress.gateway_session_digest);
      if (existing) { challenge = existing; return; }
      if (this.store.oppositeLive(requestId, decision, ingress.gateway_session_digest)) {
        throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "opposite");
      }
      if (this.store.countLiveChallenges() >= this.options.policy.remote_approval.live_challenge_cap) {
        throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_RATE_LIMITED, "cap");
      }
      const request = loadEligibleRequest(this.store, requestId, now);
      const owner = this.ensureOwner(now);
      const challengeId = `rch_${randomBytes(16).toString("hex")}`;
      const nonce = randomBytes(32).toString("base64url");
      const expires = new Date(Math.min(
        now.getTime() + this.options.policy.remote_approval.challenge_ttl_seconds * 1000,
        Date.parse(request.expires_at),
      )).toISOString();
      const binding: RemoteApprovalBindingV1 = {
        schema_version: 1, challenge_id: challengeId, request_id: requestId, decision,
        command_digest: request.command_digest as `sha256:${string}`, action: request.action, action_level: request.action_level,
        target_digest: request.target_digest, args_digest: request.args_digest, request_nonce_digest: request.nonce_digest,
        remote_principal_id: owner.principal_id, user_handle_digest: owner.user_handle_digest as `sha256:${string}`,
        gateway_owner_digest: ingress.gateway_owner_digest, gateway_session_digest: ingress.gateway_session_digest,
        origin: this.options.origin, rp_id: this.options.rpId, issued_at: at, expires_at: expires, challenge_nonce: nonce,
      };
      const challengeB64 = bindingChallenge(binding);
      const row: ChallengeRow = {
        ...binding, command_digest: binding.command_digest, target_digest: binding.target_digest, args_digest: binding.args_digest,
        request_nonce_digest: binding.request_nonce_digest, challenge_b64: challengeB64, challenge_nonce: nonce,
        binding_digest: sha256Prefixed(canonicalize(binding)), state: "issued", attempts: 0, reserved_at: null,
        reservation_expires_at: null, issued_at: at, expires_at: expires,
      };
      this.store.insertChallenge(row);
      challenge = row;
    });
    tx.immediate();
    if (!challenge) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "issue");
    return {
      challenge_id: challenge.challenge_id,
      options: {
        challenge: challenge.challenge_b64, rpId: this.options.rpId,
        timeout: this.options.policy.remote_approval.challenge_ttl_seconds * 1000,
        userVerification: "required", allowCredentials: [],
      },
    };
  }

  async verify(
    challengeId: string,
    rawBody: Buffer,
    ingress: RemoteIngressContextV1,
    now: Date,
  ): Promise<{ receipt_id: string; request_id: string; decision: "approve" | "reject" }> {
    this.requireReady(now);
    this.requireIngress(ingress, `/api/v1/remote-approvals/${challengeId}/verify`, "POST");
    const at = this.nowIso(now);
    this.commitExpiry(challengeId, at, now);
    const row = this.store.challenge(challengeId);
    if (!row) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_UNAVAILABLE, "missing");
    const early = this.earlyRejection(row, ingress, now);
    if (early !== undefined) {
      this.options.db.db.transaction(() => {
        writeRemoteAudit(this.store, row, now, early.outcome, early.reason);
      }).immediate();
      throw new RemoteApprovalError(early.code, early.reason);
    }
    const reserveWindow = this.options.policy.remote_approval.verification_reservation_ttl_seconds * 1000;
    const challenge = this.options.db.db.transaction(() => {
      const live = this.store.challenge(challengeId);
      if (!live || live.state !== "issued") {
        throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, live?.state ?? "missing");
      }
      this.store.reserveChallenge(challengeId, at, new Date(now.getTime() + reserveWindow).toISOString());
      return live;
    }).immediate();
    try {
      return await translateReservedAssertion(this.options, this.store, challenge, rawBody, ingress, now);
    } catch (error) {
      const reason = error instanceof RemoteApprovalError ? error.reason : "verify";
      this.options.db.db.transaction(() => {
        this.store.finishChallenge(challengeId, "rejected", reason);
        writeRemoteAudit(this.store, challenge, now, "rejected", reason, assertionAuditFlags(rawBody));
      }).immediate();
      throw error instanceof RemoteApprovalError ? error : new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "verify");
    }
  }

  private commitExpiry(challengeId: string, at: string, now: Date): void {
    this.options.db.db.transaction(() => {
      this.store.expireChallenges(at);
      const current = this.store.challenge(challengeId);
      if (current !== undefined && (current.state === "issued" || current.state === "verifying")
        && Date.parse(current.expires_at) <= now.getTime()) {
        this.options.db.db.prepare(
          "UPDATE webauthn_approval_challenges_v2 SET state='expired', terminal_reason='expired' WHERE challenge_id=? AND state IN ('issued','verifying')",
        ).run(challengeId);
      }
    }).immediate();
  }

  private earlyRejection(
    row: ChallengeRow,
    ingress: RemoteIngressContextV1,
    now: Date,
  ): { readonly code: (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES]; readonly reason: string; readonly outcome: "expired" | "rejected" } | undefined {
    if (row.state === "expired" || Date.parse(row.expires_at) <= now.getTime()) {
      return { code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: "expired", outcome: "expired" };
    }
    if (row.state !== "issued") {
      return { code: REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, reason: row.state, outcome: "rejected" };
    }
    if (row.gateway_session_digest !== ingress.gateway_session_digest || row.gateway_owner_digest !== ingress.gateway_owner_digest) {
      return { code: REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, reason: "session", outcome: "rejected" };
    }
    return undefined;
  }

  status(challengeId: string, ingress: RemoteIngressContextV1, now: Date): Record<string, unknown> {
    this.requireReady(now);
    this.requireIngress(ingress, `/api/v1/remote-approvals/${challengeId}/status`, "GET");
    const row = this.store.challenge(challengeId);
    if (!row || row.gateway_session_digest !== ingress.gateway_session_digest) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_UNAVAILABLE, "status");
    }
    const receipts = this.store.receiptCount(row.request_id);
    const request = this.store.pendingRequest(row.request_id);
    const translated = row.state === "consumed" && receipts === 1;
    return {
      schema_version: 1, challenge_id: challengeId, request_id: row.request_id, decision: row.decision,
      state: translated ? (request && String(request.state) === "approved" ? "approved" : String(request?.state ?? "translated")) : row.state,
      translated,
    };
  }
}
