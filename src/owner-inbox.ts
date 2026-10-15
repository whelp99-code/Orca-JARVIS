import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { ControlPlane, type CommandApprovalReceipt } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ControlReceiptSigner } from "./remote-approval-signer.js";
import { carryNonSensitiveConfirm, type ConfirmCarry } from "./memory-confirm-carry.js";
import { KNOWN_CONTROL_ACTIONS } from "./control-actions.js";
import { approvedActionHasExecutor } from "./approved-executor.js";
import { EXTERNAL_DELEGATE_RECEIPT_WINDOW_MS, externalDelegateRequester } from "./external-delegate.js";
import { companyTargetSchema, companyArgumentsSchema } from "./company-candidate-contract.js";
import { companyArgumentsV2Schema, companyTargetV2Schema } from "./company-candidate-v2-contract.js";

/** Every staged control action can be signed here. Unknown actions stay forbidden. */
export const OWNER_INBOX_ACTIONS = KNOWN_CONTROL_ACTIONS;

export type OwnerInboxAction = string;

export const OWNER_INBOX_MANUAL_WAIT = "승인됨 — 실행 대기(수동)";
export const OWNER_INBOX_EXTERNAL_DONE = "승인됨 — 외부 실행";
export type OwnerInboxDecision = "approve" | "reject";

export type InboxAssertion = Readonly<{
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string;
}>;

export type AssertionCheck = (input: Readonly<{
  assertion: InboxAssertion;
  expectedChallenge: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  origin: string;
  rpId: string;
}>) => Promise<{ readonly ok: true; readonly newCounter: number } | { readonly ok: false }>;

type ChallengeRow = Readonly<{
  challenge_id: string;
  request_id: string;
  decision: string;
  command_digest: string;
  challenge: string;
  expires_at: string;
  used_at: string | null;
}>;

export type OwnerInboxItem = Readonly<{
  request_id: string;
  action: OwnerInboxAction;
  summary: string;
  command_digest: string;
  expires_at: string;
  requested_at: string;
  expired: boolean;
  manual_wait: boolean;
  needs_review: boolean;
  failure_code: string | null;
  batch_summary?: string;
  batch_items?: readonly {
    action_kind: string;
    summary: string;
    payload_digest: string;
    mail_to?: string;
    mail_subject?: string;
  }[];
  requester_label?: string;
  company_candidate?: Readonly<{
    provider_instance_id: string; workspace_id: string; candidate_id: string;
    content_digest: string; owner: string; projects: readonly string[];
    policy_revision: string; deletion_sequence: number; deletion_set_root: string;
    processor_principal_id: string; status: string;
    approver_principal_id?: string; approval_policy_version?: number; approval_binding_digest?: string;
  }>;
}>;

const ACTION_SUMMARY: Readonly<Record<string, string>> = {
  "memory.confirm": "기억 확인을 승인합니다",
  "memory.outbox.dispatch": "기억을 보내도록 승인합니다",
  "memory.outbox.abandon-not-delivered": "전달되지 않은 기억을 닫도록 승인합니다",
  "company.candidate.transition": "회사 후보 1건 수락과 완료 증거 확인 후 처리 완료를 승인합니다. 거절하면 이 후보를 닫습니다.",
};

type Row = Readonly<{
  request_id: string;
  action: string;
  command_digest: string;
  expires_at: string;
  requested_at: string;
  state: string;
  failure_code: string | null;
  args_json?: string;
  requested_by?: string;
  target_json?: string;
  company_status?: string | null;
  company_first_use_expires_at?: string | null;
  schema_version?: number | null;
}>;

export class OwnerInbox {
  constructor(
    private readonly db: AuthorityDb,
    private readonly signer: ControlReceiptSigner,
    private readonly signerReady: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): readonly OwnerInboxItem[] {
    const now = this.now().getTime();
    const rows = this.db.db.prepare(
      `SELECT r.request_id,r.action,r.command_digest,r.expires_at,r.requested_at,r.state,
         COALESCE(h.failure_code,r.failure_code) AS failure_code,r.args_json,r.target_json,r.requested_by,r.schema_version,
         h.status AS company_status,
         CASE WHEN h.current=1 AND NOT EXISTS (
           SELECT 1 FROM company_candidate_sb_receipts s WHERE s.request_id=r.request_id
             AND s.operation=CASE a.decision WHEN 'approve' THEN 'accept' ELSE 'reject' END
         ) THEN a.expires_at ELSE NULL END AS company_first_use_expires_at
       FROM control_command_requests r
       LEFT JOIN company_candidate_handoffs h ON h.request_id=r.request_id
       LEFT JOIN control_command_receipts a ON a.request_id=r.request_id
       WHERE r.state IN ('pending', 'approved', 'failed', 'uncertain')
         OR (r.state='rejected' AND r.action='company.candidate.transition' AND h.current=1
           AND h.status NOT IN ('rejected','completed','superseded'))
       ORDER BY r.requested_at,r.request_id`,
    ).all() as Row[];
    return rows.filter(row => visible(row)).map(row => {
      const expiresAt = row.company_first_use_expires_at
        && Date.parse(row.company_first_use_expires_at) < Date.parse(row.expires_at)
        ? row.company_first_use_expires_at : row.expires_at;
      return itemOf({ ...row, expires_at: expiresAt }, Date.parse(expiresAt) <= now);
    });
  }

  issueChallenge(input: Readonly<{
    request_id: string;
    decision: OwnerInboxDecision;
    command_digest: string;
    session_id: string;
  }>): { readonly challenge_id: string; readonly challenge: string; readonly expires_at: string } {
    this.guardPending(input);
    const now = this.now();
    const challenge = randomBytes(32).toString("base64url");
    const challengeId = `ich:${randomUUID()}`;
    const expires = new Date(now.getTime() + 120_000).toISOString();
    this.db.db.prepare(
      `INSERT INTO owner_inbox_challenges(
        challenge_id, request_id, decision, command_digest, challenge, expires_at, created_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run(challengeId, input.request_id, input.decision, input.command_digest, challenge, expires, now.toISOString());
    return { challenge_id: challengeId, challenge, expires_at: expires };
  }

  async decide(input: Readonly<{
    request_id: string;
    decision: OwnerInboxDecision;
    command_digest: string;
    session_id: string;
    challenge_id: string;
    assertion: InboxAssertion | undefined;
    check: AssertionCheck;
    origin: string;
    rpId: string;
  }>): Promise<{ readonly request_id: string; readonly state: "approved" | "rejected"; readonly carried?: ConfirmCarry }> {
    const fail = (code: string): never => {
      this.audit("failure", input.request_id, input.decision, input.command_digest, input.session_id, code);
      throw new JarvisError(code);
    };
    if (!this.signerReady) fail("OWNER_INBOX_UNCONFIGURED");
    if (input.session_id.length === 0) fail("OWNER_INBOX_IDENTITY_REQUIRED");
    const prior = this.db.db.prepare(
      "SELECT used_at FROM owner_inbox_challenges WHERE challenge_id = ?",
    ).get(input.challenge_id) as { used_at: string | null } | undefined;
    if (prior?.used_at) fail("OWNER_INBOX_REPLAY");
    try {
      this.guardPending(input);
    } catch (error) {
      if (error instanceof JarvisError) fail(error.code);
      throw error;
    }
    if (input.assertion === undefined) fail("OWNER_INBOX_WEBAUTHN_REQUIRED");
    const challenge = this.db.db.prepare(
      `SELECT challenge_id, request_id, decision, command_digest, challenge, expires_at, used_at
       FROM owner_inbox_challenges WHERE challenge_id = ?`,
    ).get(input.challenge_id) as ChallengeRow | undefined;
    const bound = defined(challenge, "OWNER_INBOX_WEBAUTHN_REQUIRED");
    if (bound.used_at !== null) fail("OWNER_INBOX_REPLAY");
    if (Date.parse(bound.expires_at) <= this.now().getTime()) fail("OWNER_INBOX_EXPIRED");
    if (bound.request_id !== input.request_id || bound.decision !== input.decision
      || bound.command_digest !== input.command_digest) fail("OWNER_INBOX_DIGEST_MISMATCH");
    const assertion = input.assertion as InboxAssertion;
    const credential = this.db.db.prepare(
      "SELECT credential_id, public_key, counter FROM owner_inbox_credentials WHERE credential_id = ?",
    ).get(assertion.id) as { credential_id: string; public_key: Buffer; counter: number } | undefined;
    const stored = defined(credential, "OWNER_INBOX_ASSERTION_REJECTED");
    const checked = await input.check({
      assertion,
      expectedChallenge: bound.challenge,
      credentialId: stored.credential_id,
      publicKey: stored.public_key,
      counter: stored.counter,
      origin: input.origin,
      rpId: input.rpId,
    });
    if (!checked.ok) fail("OWNER_INBOX_ASSERTION_REJECTED");
    const newCounter = checked.ok ? checked.newCounter : 0;
    const marked = this.db.db.prepare(
      "UPDATE owner_inbox_challenges SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL",
    ).run(this.now().toISOString(), bound.challenge_id);
    if (marked.changes !== 1) fail("OWNER_INBOX_REPLAY");
    this.db.db.prepare("UPDATE owner_inbox_credentials SET counter = ? WHERE credential_id = ?")
      .run(newCounter, stored.credential_id);
    const now = this.now();
    const row = this.one(input.request_id);
    const issued = now.toISOString();
    const windowMs = row.action === "external.delegate" ? EXTERNAL_DELEGATE_RECEIPT_WINDOW_MS : 10 * 60_000;
    const receiptExpires = new Date(Math.min(Date.parse(row.expires_at), now.getTime() + windowMs)).toISOString();
    const receipt: Omit<CommandApprovalReceipt, "signature"> = {
      schema_version: 1,
      receipt_id: `rcpt:${randomUUID()}`,
      request_id: row.request_id,
      decision: input.decision,
      command_digest: row.command_digest,
      signer_principal_id: this.signer.principalId,
      authenticated_session_id: input.session_id,
      key_id: this.signer.keyId,
      algorithm: "Ed25519",
      issued_at: issued,
      not_before: issued,
      expires_at: receiptExpires,
      nonce: `inbox:${randomUUID()}`,
      max_uses: 1,
      status: "issued",
    };
    const signed = this.signer.signVerifiedRemoteDecision(receipt);
    try {
      new ControlPlane(this.db).decide(signed, now);
    } catch (error) {
      if (error instanceof JarvisError && error.code === "CONTROL_APPROVAL_INVALID") {
        fail("OWNER_INBOX_KEY_MISMATCH");
      }
      throw error;
    }
    this.audit("success", row.request_id, input.decision, row.command_digest, input.session_id, "ok");
    const state = input.decision === "approve" ? "approved" : "rejected";
    if (state !== "approved" || row.action !== "memory.confirm") {
      return { request_id: row.request_id, state };
    }
    const carried = carryNonSensitiveConfirm({
      authority: this.db, requestId: row.request_id, now, signer: this.signer,
    });
    return { request_id: row.request_id, state, carried };
  }

  enroll(code: string, credential: Readonly<{ id: string; publicKey: Buffer; counter: number }>): void {
    const expected = process.env.JARVIS_OWNER_INBOX_ENROLLMENT_CODE;
    if (expected === undefined || expected.length < 16) throw new JarvisError("OWNER_INBOX_UNCONFIGURED");
    const given = Buffer.from(code);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      this.audit("failure", "enrollment", "reject", "", "", "OWNER_INBOX_IDENTITY_REQUIRED");
      throw new JarvisError("OWNER_INBOX_IDENTITY_REQUIRED");
    }
    const digest = createHash("sha256").update(want).digest("hex");
    const used = this.db.db.prepare("SELECT 1 FROM owner_inbox_enrollment_uses WHERE code_digest = ?").get(digest);
    if (used !== undefined) throw new JarvisError("OWNER_INBOX_REPLAY");
    const now = this.now().toISOString();
    this.db.db.prepare("INSERT INTO owner_inbox_enrollment_uses(code_digest, used_at) VALUES(?,?)").run(digest, now);
    this.db.db.prepare(
      "INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)",
    ).run(credential.id, credential.publicKey, credential.counter, now);
    this.audit("success", "enrollment", "approve", digest, "", "enrolled");
  }

  private guardPending(input: Readonly<{ request_id: string; decision: OwnerInboxDecision; command_digest: string; session_id: string }>): void {
    if (input.session_id.length === 0) throw new JarvisError("OWNER_INBOX_IDENTITY_REQUIRED");
    if (input.decision !== "approve" && input.decision !== "reject") throw new JarvisError("OWNER_INBOX_INVALID");
    const row = this.one(input.request_id);
    if (!isAllowed(row.action)) throw new JarvisError("OWNER_INBOX_ACTION_FORBIDDEN");
    if (row.action === "company.candidate.transition" && !this.db.db.prepare(
      "SELECT 1 FROM company_candidate_handoffs WHERE request_id=? AND command_digest=? AND current=1",
    ).get(row.request_id, row.command_digest)) throw new JarvisError("OWNER_INBOX_NOT_PENDING");
    if (row.state !== "pending") throw new JarvisError("OWNER_INBOX_NOT_PENDING");
    if (row.command_digest !== input.command_digest) throw new JarvisError("OWNER_INBOX_DIGEST_MISMATCH");
    if (Date.parse(row.expires_at) <= this.now().getTime()) throw new JarvisError("OWNER_INBOX_EXPIRED");
  }

  private audit(outcome: "success" | "failure", subject: string, decision: string, digest: string, sessionId: string, code: string): void {
    this.db.db.prepare(
      "INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)",
    ).run(
      "owner_inbox_attempt",
      subject,
      JSON.stringify({ outcome, decision, command_digest: digest, session_id: sessionId, code, key_id: this.signer.keyId }),
      this.now().toISOString(),
    );
  }

  private one(requestId: string): Row {
    const row = this.db.db.prepare(
      `SELECT request_id, action, command_digest, expires_at, requested_at, state
       FROM control_command_requests WHERE request_id = ?`,
    ).get(requestId) as Row | undefined;
    if (row === undefined) throw new JarvisError("OWNER_INBOX_NOT_FOUND");
    return row;
  }
}

function defined<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new JarvisError(code); return value;
}

function isAllowed(action: string): boolean {
  return (OWNER_INBOX_ACTIONS as readonly string[]).includes(action);
}

function visible(row: Row): boolean {
  if (!isAllowed(row.action)) return false;
  if (row.action === "company.candidate.transition" && row.company_status == null) return false;
  if (row.state === "rejected") return row.action === "company.candidate.transition";
  if (row.state === "pending") return true;
  if (row.state === "failed" || row.state === "uncertain") return true;
  return row.state === "approved" && !approvedActionHasExecutor(row.action);
}

function itemOf(row: Row, expired: boolean): OwnerInboxItem {
  const rejectedCompany = row.action === "company.candidate.transition" && row.state === "rejected";
  const manual = rejectedCompany || (row.state === "approved" && !approvedActionHasExecutor(row.action));
  const external = externalDisplay(row);
  const companyArgs = row.action === "company.candidate.transition" && row.args_json
    ? Number(row.schema_version) === 2
      ? companyArgumentsV2Schema.parse(JSON.parse(row.args_json))
      : companyArgumentsSchema.parse(JSON.parse(row.args_json))
    : undefined;
  const company = row.action === "company.candidate.transition" && row.target_json && companyArgs
    ? { ...(Number(row.schema_version) === 2 ? companyTargetV2Schema : companyTargetSchema).parse(JSON.parse(row.target_json)),
      ...companyArgs, status: row.company_status ?? "unimported" }
    : undefined;
  const base = external?.summary ?? ACTION_SUMMARY[row.action] ?? row.action;
  const approvedText = row.action === "external.delegate" ? OWNER_INBOX_EXTERNAL_DONE : OWNER_INBOX_MANUAL_WAIT;
  return {
    request_id: row.request_id,
    action: row.action,
    summary: rejectedCompany ? "거절됨 — SB 전달 대기(수동)"
      : manual ? company ? `${base} (${company.status === "accepted" ? "수락됨 — 완료 확인 대기" : approvedText})` : approvedText
      : expired ? `${base} (만료됨)` : base,
    command_digest: row.command_digest,
    expires_at: row.expires_at,
    requested_at: row.requested_at,
    expired,
    manual_wait: manual,
    needs_review: row.state === "failed" || row.state === "uncertain" || row.company_status === "uncertain"
      || (expired && row.company_first_use_expires_at != null),
    failure_code: row.state === "failed" || row.state === "uncertain" || row.company_status === "uncertain" ? row.failure_code : null,
    ...(external ? { batch_summary: external.batch_summary, batch_items: external.batch_items } : {}),
    ...(external && row.requested_by ? { requester_label: externalDelegateRequester(row.requested_by)?.header } : {}),
    ...(company ? { company_candidate: company } : {}),
  };
}

function externalDisplay(row: Row): {
  summary: string;
  batch_summary: string;
  batch_items: { action_kind: string; summary: string; payload_digest: string; mail_to?: string; mail_subject?: string }[];
} | undefined {
  if (row.action !== "external.delegate" || row.args_json === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.args_json); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const args = parsed as { batch_summary?: unknown; items?: unknown };
  const batchSummary = typeof args.batch_summary === "string" ? args.batch_summary : "";
  const items = Array.isArray(args.items) ? args.items.flatMap(item => {
    if (typeof item !== "object" || item === null) return [];
    const rowItem = item as { action_kind?: unknown; summary?: unknown; payload_digest?: unknown; mail_to?: unknown; mail_subject?: unknown };
    if (typeof rowItem.action_kind !== "string" || typeof rowItem.summary !== "string" || typeof rowItem.payload_digest !== "string") return [];
    return [{
      action_kind: rowItem.action_kind,
      summary: rowItem.summary,
      payload_digest: rowItem.payload_digest,
      ...(typeof rowItem.mail_to === "string" ? { mail_to: rowItem.mail_to } : {}),
      ...(typeof rowItem.mail_subject === "string" ? { mail_subject: rowItem.mail_subject } : {}),
    }];
  }) : [];
  return {
    summary: `윤비서 요청 · ${items.length}건 묶음 · 30분 내 승인`,
    batch_summary: batchSummary,
    batch_items: items,
  };
}
