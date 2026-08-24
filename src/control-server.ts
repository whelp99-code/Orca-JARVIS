import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput, type StoredControlCommand } from "./control-plane.js";
import { FORBIDDEN_AUTHORITY_FIELDS, type CommandIntent } from "./control-protocol.js";
import { createLocalWorktree, inspectWorktree, worktreeEffectKey, type WorktreeCreateArgs } from "./control-methods/worktree.js";

export type WorktreeIntent = {
  readonly ingressIdempotencyKey: string;
  readonly repository: string;
  readonly parentPath: string;
  readonly branch: string;
  readonly name: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
};

export type WorktreeRequestResult = {
  readonly request_id: string;
  readonly command_digest: string;
  readonly effect_key: string;
  readonly state: StoredControlCommand["state"];
  readonly replayed: boolean;
};

export type LocalApprover = (staged: StoredControlCommand) => CommandApprovalReceipt;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertShellIntent(intent: CommandIntent): void {
  if (FORBIDDEN_AUTHORITY_FIELDS.some(field => field in intent || field in intent.target || field in intent.args)) {
    throw new JarvisError("CONTROL_AUTHORITY_FIELD_INJECTED");
  }
}

export function worktreeIntentFromCommand(intent: CommandIntent): WorktreeIntent {
  assertShellIntent(intent);
  const repository = intent.target.repository;
  const parentPath = intent.target.parent_path;
  const branch = intent.args.branch;
  const name = intent.args.name;
  if (typeof repository !== "string" || typeof parentPath !== "string" || typeof branch !== "string" || typeof name !== "string") {
    throw new JarvisError("CONTROL_COMMAND_INVALID");
  }
  return {
    ingressIdempotencyKey: intent.ingressIdempotencyKey,
    repository,
    parentPath,
    branch,
    name,
    requestedAt: intent.requestedAt,
    expiresAt: intent.expiresAt,
  };
}

export class JarvisControlServer {
  private readonly control: ControlPlane;
  constructor(
    private readonly db: AuthorityDb,
    private readonly principal = "test-operator",
    private readonly createWorktree = createLocalWorktree,
  ) {
    this.control = new ControlPlane(db);
  }

  private argsOf(intent: WorktreeIntent): WorktreeCreateArgs {
    return { repository: intent.repository, parentPath: intent.parentPath, branch: intent.branch, name: intent.name };
  }

  requestWorktree(intent: WorktreeIntent, now = new Date()): WorktreeRequestResult {
    if (!intent.ingressIdempotencyKey) throw new JarvisError("CONTROL_COMMAND_INVALID");
    const effectKey = worktreeEffectKey(this.argsOf(intent));
    const payloadDigest = `sha256:${createHash("sha256").update(canonicalize(intent)).digest("hex")}`;
    const prior = this.db.db.prepare("SELECT request_id, effect_key, payload_digest FROM control_ingress_requests WHERE ingress_key=?").get(intent.ingressIdempotencyKey) as { request_id: string; effect_key: string; payload_digest: string } | undefined;
    if (prior) {
      if (prior.payload_digest !== payloadDigest) throw new JarvisError("CONTROL_INGRESS_CONFLICT");
      const existing = this.control.list().find(item => item.request_id === prior.request_id);
      if (!existing) throw new JarvisError("CONTROL_INGRESS_ORPHAN");
      return { request_id: existing.request_id, command_digest: existing.command_digest, effect_key: prior.effect_key, state: existing.state, replayed: true };
    }
    const input: ControlCommandRequestInput = {
      schema_version: 1,
      request_id: `wt_${createHash("sha256").update(intent.ingressIdempotencyKey).digest("hex").slice(0, 16)}`,
      action: "worktree.create",
      action_level: 2,
      target: { environment: "local", repository: intent.repository, parent_path: intent.parentPath },
      args: { branch: intent.branch, name: intent.name },
      reversible: true,
      requested_by: this.principal,
      requested_at: intent.requestedAt,
      expires_at: intent.expiresAt,
      nonce: `nonce-${intent.ingressIdempotencyKey}`,
    };
    const staged = this.control.stage(input, now);
    this.db.db.prepare("INSERT INTO control_ingress_requests(ingress_key,request_id,effect_key,payload_digest,created_at) VALUES(?,?,?,?,?)").run(intent.ingressIdempotencyKey, staged.request_id, effectKey, payloadDigest, now.toISOString());
    return { request_id: staged.request_id, command_digest: staged.command_digest, effect_key: effectKey, state: staged.state, replayed: false };
  }

  approve(requestId: string, approver: LocalApprover): void {
    const staged = this.control.list().find(item => item.request_id === requestId);
    if (!staged) throw new JarvisError("CONTROL_APPROVAL_NOT_APPLICABLE");
    const receipt = approver(staged);
    this.control.decide(receipt, new Date());
  }

  claimApproved(requestId: string, worker = "jarvis-control-server", now = new Date()) {
    return this.control.claim(requestId, worker, now);
  }

  execute(requestId: string, worker = "jarvis-control-server", now = new Date()): { state: "completed" | "failed" | "uncertain"; result: unknown } {
    const claimed = this.control.claim(requestId, worker, now);
    const intent: WorktreeCreateArgs = {
      repository: String(claimed.target.repository),
      parentPath: String(claimed.target.parent_path),
      branch: String(claimed.args.branch),
      name: String(claimed.args.name),
    };
    try {
      const result = this.createWorktree(intent);
      this.control.settle(requestId, claimed.fence, { state: "completed", effect_type: "worktree.created", payload: result }, now);
      return { state: "completed", result };
    } catch (error) {
      const code = error instanceof JarvisError ? error.code : "WORKTREE_CREATE_FAILED";
      const message = error instanceof Error ? error.message : code;
      this.control.settle(requestId, claimed.fence, { state: "failed", effect_type: "worktree.created", payload: { error: code, message }, failure_code: code }, now);
      return { state: "failed", result: { error: code, message } };
    }
  }

  recover(requestId: string, worker = "jarvis-control-server", now = new Date()): { state: "completed" | "uncertain"; path?: string } {
    const row = this.control.list().find(item => item.request_id === requestId);
    if (!row) throw new JarvisError("CONTROL_COMMAND_INVALID");
    if (row.state === "completed") return { state: "completed" };
    const args: WorktreeCreateArgs = {
      repository: String(row.target.repository),
      parentPath: String(row.target.parent_path),
      branch: String(row.args.branch),
      name: String(row.args.name),
    };
    const seen = inspectWorktree(args);
    if (row.state === "claimed") {
      const claimed = this.db.db.prepare("SELECT lease_fence FROM control_command_requests WHERE request_id=?").get(requestId) as { lease_fence: number };
      if (seen.exists) {
        this.control.settle(requestId, claimed.lease_fence, { state: "completed", effect_type: "worktree.created", payload: { path: seen.path, recovered: true } }, now);
        return { state: "completed", path: seen.path };
      }
      this.control.settle(requestId, claimed.lease_fence, { state: "uncertain", effect_type: "worktree.created", payload: { recovered: true }, failure_code: "WORKTREE_RECOVERY_UNCERTAIN" }, now);
      return { state: "uncertain", path: seen.path };
    }
    void worker;
    return { state: seen.exists ? "completed" : "uncertain", path: seen.path };
  }
}

export function localTestApprover(key: Parameters<typeof signCommandApproval>[1], principal = "test-operator", session = "action-hub-session", keyId = "decision-test"): LocalApprover {
  return staged => signCommandApproval({
    schema_version: 1,
    receipt_id: `approve-${staged.request_id}-${randomUUID()}`,
    request_id: staged.request_id,
    decision: "approve",
    command_digest: staged.command_digest,
    signer_principal_id: principal,
    authenticated_session_id: session,
    key_id: keyId,
    algorithm: "Ed25519",
    issued_at: new Date().toISOString(),
    not_before: new Date().toISOString(),
    expires_at: staged.expires_at,
    nonce: `approval-${staged.request_id}`,
    max_uses: 1,
    status: "issued",
  }, key);
}

export function commandIntentFromWorktree(intent: WorktreeIntent): CommandIntent {
  return {
    ingressIdempotencyKey: intent.ingressIdempotencyKey,
    requestedMethod: "command.request",
    target: { repository: intent.repository, parent_path: intent.parentPath },
    args: { branch: intent.branch, name: intent.name },
    requestedAt: intent.requestedAt,
    expiresAt: intent.expiresAt,
  };
}
