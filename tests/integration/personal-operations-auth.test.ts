import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, insertApproval, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

function enroll(db: AuthorityDb, suffix: string): void {
  const principalId = `rpr:${suffix}`; const publicKeyDigest = `sha256:${createHash("sha256").update(`credential:${suffix}`).digest("hex")}`;
  const approval = insertApproval(db, { suffix: `enroll-${suffix}`, action: "remote.principal.enroll", target: { principal_id: principalId, subject_digest: digest("a"), public_key_digest: publicKeyDigest, target_digest: digest("b") }, args: { operation: "enroll", args_digest: digest("c"), local_owner_session_id: "session:local-owner" } });
  db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES(?,?,?,?)").run(principalId, "absent", digest("a"), T0);
  db.db.prepare("UPDATE remote_principals SET state='active',credential_public_key_digest=?,target_digest=?,args_digest=?,local_owner_session_id=?,enrollment_request_id=?,enrollment_receipt_id=?,enrollment_receipt_digest=?,enrollment_expires_at=?,activated_at=? WHERE principal_id=?").run(publicKeyDigest, digest("b"), digest("c"), "session:local-owner", approval.requestId, approval.receiptId, approval.receiptDigest, T5, T1, principalId);
  db.db.prepare("INSERT INTO webauthn_credentials(credential_id,principal_id,public_key_cose,public_key_digest,sign_count,state,rp_id,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`cred:${suffix}`, principalId, `public-cose:${suffix}`, publicKeyDigest, 0, "active", "jarvis.local", "https://jarvis.local", T1);
}

function issue(db: AuthorityDb, suffix: string, principal = suffix, issuedAt = T1, expiresAt = T3): void {
  const approval = insertApproval(db, { suffix: `command-${suffix}`, action: "task.approve", target: { target_digest: digest("e") }, args: { args_digest: digest("f") } });
  const challengeDigest = `sha256:${createHash("sha256").update(`challenge:${suffix}`).digest("hex")}`; const nonceDigest = `sha256:${createHash("sha256").update(`nonce:${suffix}`).digest("hex")}`;
  db.db.prepare("INSERT INTO webauthn_challenges(challenge_id,command_request_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,state,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`rch:${suffix}`, approval.requestId, `rpr:${principal}`, `cred:${principal}`, `session:${principal}`, approval.commandDigest, digest("e"), digest("f"), challengeDigest, nonceDigest, "jarvis.local", "https://jarvis.local", "issued", issuedAt, expiresAt);
}

function assertion(db: AuthorityDb, assertionId: string, challengeId: string, assertionDigest: string, count: number, assertedAt = T2): void {
  const challenge = db.db.prepare("SELECT * FROM webauthn_challenges WHERE challenge_id=?").get(challengeId) as Record<string, unknown>;
  db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,nonce_digest,rp_id,origin,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(assertionId, challengeId, challenge.principal_id, challenge.credential_id, challenge.session_id, challenge.command_digest, challenge.target_digest, challenge.args_digest, challenge.nonce_digest, challenge.rp_id, challenge.origin, assertionDigest, count, 1, assertedAt);
}

describe("remote authentication persistence", () => {
  it("activates receipt-bound principals and rejects inactive challenge issuers", async () => {
    // Given an exactly enrolled principal
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "owner");
      // When credential is revoked
      db.db.prepare("UPDATE webauthn_credentials SET state='revoked',revoked_at=? WHERE credential_id='cred:owner'").run(T2);
      // Then further challenge issuance and remote self-enrollment fail
      expect(() => issue(db, "revoked", "owner")).toThrow("remote challenge binding invalid");
      expect(() => db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES(?,?,?,?)").run("rpr:self", "active", digest("5"), T0)).toThrow(/remote principal (must start absent|enrollment required)|CHECK constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("atomically consumes one challenge and rejects challenge and digest replay", async () => {
    // Given an issued exact challenge
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "owner");
      // When one assertion is inserted
      assertion(db, "rap:one", "rch:owner", digest("6"), 1);
      // Then challenge and counter settle atomically and replay fails
      expect(db.db.prepare("SELECT state,consumed_at FROM webauthn_challenges WHERE challenge_id='rch:owner'").get()).toEqual({ state: "consumed", consumed_at: T2 });
      expect(db.db.prepare("SELECT sign_count FROM webauthn_credentials WHERE credential_id='cred:owner'").get()).toEqual({ sign_count: 1 });
      expect(() => assertion(db, "rap:two", "rch:owner", digest("7"), 2)).toThrow(/webauthn challenge unavailable|UNIQUE constraint failed/);
      issue(db, "second", "owner"); expect(() => assertion(db, "rap:three", "rch:second", digest("6"), 2)).toThrow(/UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("rejects challenge consumption and counter changes without assertion proof", async () => {
    // Given an issued exact challenge
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "owner");
      // When direct state updates bypass assertion insertion
      // Then both are rejected
      expect(() => db.db.prepare("UPDATE webauthn_challenges SET state='consumed',consumed_at=? WHERE challenge_id='rch:owner'").run(T2)).toThrow("webauthn assertion required");
      expect(() => db.db.prepare("UPDATE webauthn_credentials SET sign_count=1 WHERE credential_id='cred:owner'").run()).toThrow("webauthn assertion counter required");
    } finally { closePersonalDb(db); }
  });

  it("rejects the exact expiry boundary without consuming the challenge", async () => {
    // Given a challenge expiring at T2
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "expired", "owner", T0, T2);
      // When assertion arrives exactly at expiry
      // Then it fails and remains unconsumed
      expect(() => assertion(db, "rap:expired", "rch:expired", digest("8"), 1)).toThrow("webauthn challenge expired");
      expect(db.db.prepare("SELECT state FROM webauthn_challenges WHERE challenge_id='rch:expired'").get()).toEqual({ state: "issued" });
    } finally { closePersonalDb(db); }
  });

  it("keeps personal operation audit minimized and append-only", async () => {
    // Given a migrated database
    const db = await personalDb();
    try {
      // When a digest-only audit event is appended
      db.db.prepare("INSERT INTO personal_operation_audit_events(event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("aud:one", "remote.assertion.consumed", "challenge", "rch:one", "rpr:owner", "corr:one", null, digest("0"), T4);
      // Then update/delete fail and no content-bearing column exists
      expect(() => db.db.prepare("UPDATE personal_operation_audit_events SET event_type='changed' WHERE event_id='aud:one'").run()).toThrow("immutable personal operation audit");
      expect(() => db.db.prepare("DELETE FROM personal_operation_audit_events WHERE event_id='aud:one'").run()).toThrow("immutable personal operation audit");
      const columns = (db.db.prepare("PRAGMA table_info(personal_operation_audit_events)").all() as Array<{ name: string }>).map(row => row.name);
      expect(columns.some(column => /payload|content|secret|private|biometric/i.test(column))).toBe(false);
    } finally { closePersonalDb(db); }
  });
});
