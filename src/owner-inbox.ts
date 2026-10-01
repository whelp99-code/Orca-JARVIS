import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { ControlPlane, type CommandApprovalReceipt } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ControlReceiptSigner } from "./remote-approval-signer.js";
import { carryNonSensitiveConfirm, type ConfirmCarry } from "./memory-confirm-carry.js";

/** Actions the owner inbox may sign. Anything else stays on its existing ceremony. */
export const OWNER_INBOX_ACTIONS = [
  "memory.confirm",
  "memory.outbox.dispatch",
  "memory.outbox.abandon-not-delivered",
] as const;

export type OwnerInboxAction = (typeof OWNER_INBOX_ACTIONS)[number];
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
}>;

const ACTION_SUMMARY: Readonly<Record<OwnerInboxAction, string>> = {
  "memory.confirm": "기억 확인을 승인합니다",
  "memory.outbox.dispatch": "기억을 보내도록 승인합니다",
  "memory.outbox.abandon-not-delivered": "전달되지 않은 기억을 닫도록 승인합니다",
};

type Row = Readonly<{
  request_id: string;
  action: string;
  command_digest: string;
  expires_at: string;
  requested_at: string;
  state: string;
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
      `SELECT request_id, action, command_digest, expires_at, requested_at, state
       FROM control_command_requests
       WHERE state = 'pending'
       ORDER BY requested_at, request_id`,
    ).all() as Row[];
    return rows.filter(row => isAllowed(row.action)).map(row => itemOf(row, Date.parse(row.expires_at) <= now));
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
    const receiptExpires = new Date(Math.min(Date.parse(row.expires_at), now.getTime() + 10 * 60_000)).toISOString();
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

function isAllowed(action: string): action is OwnerInboxAction {
  return (OWNER_INBOX_ACTIONS as readonly string[]).includes(action);
}

function itemOf(row: Row, expired: boolean): OwnerInboxItem {
  const action = row.action as OwnerInboxAction;
  return { request_id: row.request_id, action,
    summary: expired ? `${ACTION_SUMMARY[action]} (만료됨)` : ACTION_SUMMARY[action],
    command_digest: row.command_digest,
    expires_at: row.expires_at,
    requested_at: row.requested_at,
    expired,
  };
}
