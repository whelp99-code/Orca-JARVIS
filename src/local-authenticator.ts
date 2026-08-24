import type { KeyObject } from "node:crypto";
import { hostname } from "node:os";
import { AuthorityDb, JarvisError } from "./db.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type StoredControlCommand } from "./control-plane.js";

export type LocalSession = {
  readonly principal: string;
  readonly sessionId: string;
  readonly host: string;
  readonly environment: string;
  readonly generation: string;
  readonly localAuthAssurance: "present";
};

export type CanonicalApprovalView = {
  readonly requestId: string;
  readonly action: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reversible: boolean;
  readonly digestPrefix: string;
  readonly expiresAt: string;
  readonly host: string;
  readonly environment: string;
  readonly riskTier: number;
};

export class LocalAuthenticator {
  private readonly control: ControlPlane;
  constructor(
    private readonly db: AuthorityDb,
    private readonly session: LocalSession,
    private readonly key: KeyObject,
    private readonly keyId = "decision-test",
  ) {
    this.control = new ControlPlane(db);
  }

  view(requestId: string): CanonicalApprovalView {
    const staged = this.requirePending(requestId);
    return this.project(staged);
  }

  approve(requestId: string, claimed: LocalSession, now = new Date()): CommandApprovalReceipt {
    this.assertActiveSession(claimed);
    const staged = this.requirePending(requestId);
    if (staged.action_level >= 3 && claimed.environment !== "local") {
      throw new JarvisError("LOCAL_AUTH_REMOTE_T3_FORBIDDEN");
    }
    const issued = now.toISOString();
    const receipt = signCommandApproval({
      schema_version: 1,
      receipt_id: `local-${staged.request_id}-${now.getTime()}`,
      request_id: staged.request_id,
      decision: "approve",
      command_digest: staged.command_digest,
      signer_principal_id: this.session.principal,
      authenticated_session_id: this.session.sessionId,
      key_id: this.keyId,
      algorithm: "Ed25519",
      issued_at: issued,
      not_before: issued,
      expires_at: staged.expires_at,
      nonce: `local-${staged.request_id}`,
      max_uses: 1,
      status: "issued",
    }, this.key);
    this.control.decide(receipt, new Date(now.getTime() + 1));
    return receipt;
  }

  deny(requestId: string, claimed: LocalSession, now = new Date()): void {
    this.assertActiveSession(claimed);
    this.control.cancel({ request_id: requestId, reason: "local-deny", actor: claimed.principal, revoked_at: now.toISOString() }, now);
  }

  receiptCount(): number {
    return Number((this.db.db.prepare("SELECT COUNT(*) AS count FROM control_command_receipts").get() as { count: number }).count);
  }

  private project(staged: StoredControlCommand): CanonicalApprovalView {
    return {
      requestId: staged.request_id,
      action: staged.action,
      target: staged.target,
      arguments: staged.args,
      reversible: staged.reversible,
      digestPrefix: staged.command_digest.slice(0, 19),
      expiresAt: staged.expires_at,
      host: this.session.host,
      environment: this.session.environment,
      riskTier: staged.action_level,
    };
  }

  private requirePending(requestId: string): StoredControlCommand {
    const staged = this.control.list().find(item => item.request_id === requestId);
    if (!staged || staged.state !== "pending") throw new JarvisError("LOCAL_AUTH_NOT_PENDING");
    return staged;
  }

  private assertActiveSession(claimed: LocalSession): void {
    if (claimed.localAuthAssurance !== "present") throw new JarvisError("LOCAL_AUTH_REQUIRED");
    if (
      claimed.principal !== this.session.principal
      || claimed.sessionId !== this.session.sessionId
      || claimed.host !== this.session.host
      || claimed.environment !== this.session.environment
      || claimed.generation !== this.session.generation
    ) {
      throw new JarvisError("LOCAL_AUTH_SESSION_MISMATCH");
    }
  }
}

export function defaultLocalSession(): LocalSession {
  return {
    principal: "test-operator",
    sessionId: "action-hub-session",
    host: hostname(),
    environment: "local",
    generation: "gen-1",
    localAuthAssurance: "present",
  };
}
