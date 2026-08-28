import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { closePersonalDb, digest, insertApproval, personalDb, T0, T1, T2, T3, T4, T5 } from "./personal-operations-test-helpers.js";

function enroll(db: Awaited<ReturnType<typeof personalDb>>, suffix: string): void {
  const approval = insertApproval(db, `enroll-${suffix}`, "remote.principal.enroll", `owner:${suffix}`);
  db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,enrollment_request_id,enrollment_receipt_id,enrollment_receipt_digest,enrollment_expires_at,activated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`rpr:${suffix}`, "active", digest("a"), approval.requestId, approval.receiptId, digest("b"), T5, T1, T0);
  const publicKeyDigest = `sha256:${createHash("sha256").update(`credential:${suffix}`).digest("hex")}`;
  db.db.prepare("INSERT INTO webauthn_credentials(credential_id,principal_id,public_key_cose,public_key_digest,sign_count,state,rp_id,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`cred:${suffix}`, `rpr:${suffix}`, `public-cose-key:${suffix}`, publicKeyDigest, 0, "active", "jarvis.local", "https://jarvis.local", T1);
}

function issue(db: Awaited<ReturnType<typeof personalDb>>, suffix: string, principal = suffix, issuedAt = T1, expiresAt = T3): void {
  const challengeDigest = `sha256:${createHash("sha256").update(`challenge:${suffix}`).digest("hex")}`;
  const nonceDigest = `sha256:${createHash("sha256").update(`nonce:${suffix}`).digest("hex")}`;
  db.db.prepare("INSERT INTO webauthn_challenges(challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,state,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`rch:${suffix}`, `rpr:${principal}`, `cred:${principal}`, `session:${principal}`, digest("d"), digest("e"), digest("f"), challengeDigest, nonceDigest, "jarvis.local", "https://jarvis.local", "issued", issuedAt, expiresAt);
}

describe("remote authentication persistence", () => {
  it("activates only receipt-bound principals and issues challenges only for current credentials", async () => {
    // Given an enrolled active owner and credential
    const db = await personalDb();
    try {
      enroll(db, "owner");
      // When a current challenge is issued
      issue(db, "owner");
      // Then absent principals, revoked credentials, and unbounded challenge expiry fail
      expect(() => db.db.prepare("INSERT INTO webauthn_challenges(challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,state,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("rch:absent", "rpr:absent", "cred:absent", "session:absent", digest("d"), digest("e"), digest("f"), digest("3"), digest("4"), "jarvis.local", "https://jarvis.local", "issued", T1, T3)).toThrow(/FOREIGN KEY constraint failed|remote challenge (principal|credential) inactive/);
      db.db.prepare("UPDATE webauthn_credentials SET state='revoked',revoked_at=? WHERE credential_id='cred:owner'").run(T2);
      expect(() => issue(db, "revoked", "owner")).toThrow("remote challenge credential inactive");
      expect(() => db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES(?,?,?,?)").run("rpr:self", "active", digest("5"), T0)).toThrow("remote principal enrollment required");
    } finally { closePersonalDb(db); }
  });

  it("atomically consumes one exact challenge and rejects assertion replay", async () => {
    // Given an issued owner-bound challenge
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "owner");
      // When one matching verified assertion is inserted
      db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("rap:one", "rch:owner", "rpr:owner", "cred:owner", "session:owner", digest("d"), digest("6"), 1, 1, T2);
      // Then challenge consumption and counter update are atomic and replay fails
      expect(db.db.prepare("SELECT state,consumed_at FROM webauthn_challenges WHERE challenge_id='rch:owner'").get()).toEqual({ state: "consumed", consumed_at: T2 });
      expect(db.db.prepare("SELECT sign_count FROM webauthn_credentials WHERE credential_id='cred:owner'").get()).toEqual({ sign_count: 1 });
      expect(() => db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("rap:two", "rch:owner", "rpr:owner", "cred:owner", "session:owner", digest("d"), digest("7"), 2, 1, T2)).toThrow("webauthn challenge unavailable");
      issue(db, "second", "owner");
      expect(() => db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("rap:three", "rch:second", "rpr:owner", "cred:owner", "session:owner", digest("d"), digest("6"), 2, 1, T2)).toThrow(/UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("rejects challenge consumption and counter changes without an assertion", async () => {
    // Given an issued owner-bound challenge
    const db = await personalDb();
    try {
      enroll(db, "owner"); issue(db, "owner");
      // When storage is mutated without assertion proof
      // Then challenge consumption and counter advancement fail closed
      expect(() => db.db.prepare("UPDATE webauthn_challenges SET state='consumed',consumed_at=? WHERE challenge_id='rch:owner'").run(T2)).toThrow("webauthn assertion required");
      expect(() => db.db.prepare("UPDATE webauthn_credentials SET sign_count=1 WHERE credential_id='cred:owner'").run()).toThrow("webauthn assertion counter required");
    } finally { closePersonalDb(db); }
  });

  it("rejects expired and wrong-principal assertions without consuming challenges", async () => {
    // Given two principals and issued challenges
    const db = await personalDb();
    try {
      enroll(db, "owner"); enroll(db, "other");
      issue(db, "expired", "owner", T0, T1); issue(db, "bound", "owner");
      // When assertions arrive after expiry or with another principal
      const assertion = db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
      // Then both fail and neither challenge is consumed
      expect(() => assertion.run("rap:expired", "rch:expired", "rpr:owner", "cred:owner", "session:owner", digest("d"), digest("8"), 1, 1, T2)).toThrow("webauthn challenge expired");
      expect(() => assertion.run("rap:wrong", "rch:bound", "rpr:other", "cred:other", "session:other", digest("d"), digest("9"), 1, 1, T2)).toThrow("webauthn assertion binding mismatch");
      expect(db.db.prepare("SELECT challenge_id,state FROM webauthn_challenges WHERE challenge_id IN ('rch:expired','rch:bound') ORDER BY challenge_id").all()).toEqual([{ challenge_id: "rch:bound", state: "issued" }, { challenge_id: "rch:expired", state: "issued" }]);
    } finally { closePersonalDb(db); }
  });

  it("keeps personal operation audit minimized and append-only", async () => {
    // Given a migrated database
    const db = await personalDb();
    try {
      // When a digest-only audit event is appended
      db.db.prepare("INSERT INTO personal_operation_audit_events(event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("aud:one", "remote.assertion.consumed", "challenge", "rch:one", "rpr:owner", "corr:one", null, digest("0"), T4);
      // Then mutation and deletion fail closed and no payload column exists
      expect(() => db.db.prepare("UPDATE personal_operation_audit_events SET event_type='changed' WHERE event_id='aud:one'").run()).toThrow("immutable personal operation audit");
      expect(() => db.db.prepare("DELETE FROM personal_operation_audit_events WHERE event_id='aud:one'").run()).toThrow("immutable personal operation audit");
      const columns = (db.db.prepare("PRAGMA table_info(personal_operation_audit_events)").all() as Array<{ name: string }>).map(row => row.name);
      expect(columns.some(column => /payload|content|secret|private|biometric/i.test(column))).toBe(false);
    } finally { closePersonalDb(db); }
  });
});
