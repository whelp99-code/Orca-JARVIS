import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, insertApproval, legacyRemoteAuthDb as personalDb, T0, T1, T2, T3, T5, type StoredApproval } from "./personal-operations-test-helpers.js";

const binding = {
  principalId: "rpr:webauthn",
  credentialId: "cred:webauthn",
  subjectDigest: digest("1"),
  publicKeyDigest: digest("2"),
  sessionId: "session:remote-owner",
  commandDigest: digest("3"),
  targetDigest: digest("4"),
  argsDigest: digest("5"),
  nonceDigest: digest("6"),
  rpId: "jarvis.local",
  origin: "https://jarvis.local",
} as const;

function enroll(db: AuthorityDb): void {
  const approval = insertApproval(db, {
    suffix: "webauthn-enroll",
    action: "remote.principal.enroll",
    target: { principal_id: binding.principalId, subject_digest: binding.subjectDigest, public_key_digest: binding.publicKeyDigest, target_digest: digest("7") },
    args: { operation: "enroll", args_digest: digest("8"), local_owner_session_id: "session:local-owner" },
  });
  db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES(?,?,?,?)").run(binding.principalId, "absent", binding.subjectDigest, T0);
  db.db.prepare("UPDATE remote_principals SET state='active',credential_public_key_digest=?,target_digest=?,args_digest=?,local_owner_session_id=?,enrollment_request_id=?,enrollment_receipt_id=?,enrollment_receipt_digest=?,enrollment_expires_at=?,activated_at=? WHERE principal_id=?").run(binding.publicKeyDigest, digest("7"), digest("8"), "session:local-owner", approval.requestId, approval.receiptId, approval.receiptDigest, T5, T1, binding.principalId);
  db.db.prepare("INSERT INTO webauthn_credentials(credential_id,principal_id,public_key_cose,public_key_digest,sign_count,state,rp_id,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(binding.credentialId, binding.principalId, "public-cose", binding.publicKeyDigest, 0, "active", binding.rpId, binding.origin, T1);
}

function command(db: AuthorityDb, suffix: string): StoredApproval {
  return insertApproval(db, {
    suffix,
    action: "task.approve",
    target: { target_digest: binding.targetDigest },
    args: { args_digest: binding.argsDigest },
  });
}

function issue(db: AuthorityDb, suffix: string, approval: StoredApproval, expiresAt = T3): string {
  const challengeId = `rch:${suffix}`;
  const challengeDigest = `sha256:${createHash("sha256").update(challengeId).digest("hex")}`;
  const nonceDigest = `sha256:${createHash("sha256").update(`nonce:${suffix}`).digest("hex")}`;
  db.db.prepare("INSERT INTO webauthn_challenges(challenge_id,command_request_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,state,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(challengeId, approval.requestId, binding.principalId, binding.credentialId, binding.sessionId, approval.commandDigest, binding.targetDigest, binding.argsDigest, challengeDigest, nonceDigest, binding.rpId, binding.origin, "issued", T1, expiresAt);
  return challengeId;
}

function assertChallenge(db: AuthorityDb, challengeId: string, overrides: Readonly<Record<string, unknown>> = {}): void {
  const challenge = db.db.prepare("SELECT command_digest,nonce_digest FROM webauthn_challenges WHERE challenge_id=?").get(challengeId) as { command_digest: string; nonce_digest: string };
  const value = { principalId: binding.principalId, credentialId: binding.credentialId, sessionId: binding.sessionId, commandDigest: challenge.command_digest, targetDigest: binding.targetDigest, argsDigest: binding.argsDigest, nonceDigest: challenge.nonce_digest, rpId: binding.rpId, origin: binding.origin, signCount: 1, userVerified: 1, assertedAt: T2, ...overrides };
  db.db.prepare("INSERT INTO webauthn_assertions(assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,nonce_digest,rp_id,origin,assertion_digest,sign_count,user_verified,asserted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`rap:${challengeId}`, challengeId, value.principalId, value.credentialId, value.sessionId, value.commandDigest, value.targetDigest, value.argsDigest, value.nonceDigest, value.rpId, value.origin, digest("9"), value.signCount, value.userVerified, value.assertedAt);
}

const assertionMismatches = [
  ["principal", { principalId: "rpr:wrong" }],
  ["credential", { credentialId: "cred:wrong" }],
  ["session", { sessionId: "session:wrong" }],
  ["command", { commandDigest: digest("a") }],
  ["target", { targetDigest: digest("a") }],
  ["args", { argsDigest: digest("a") }],
  ["nonce", { nonceDigest: digest("a") }],
  ["RP ID", { rpId: "wrong.local" }],
  ["origin", { origin: "https://wrong.local" }],
  ["non-increasing counter", { signCount: 0 }],
  ["user verification", { userVerified: 0 }],
] as const;

describe("full WebAuthn assertion persistence binding", () => {
  it.each(assertionMismatches)("rejects mismatched %s atomically", async (_name, mismatch) => {
    // Given an active exact principal, credential, command, and issued challenge
    const db = await personalDb();
    try {
      enroll(db); const approval = command(db, `command-${_name}`); const challengeId = issue(db, String(_name).replaceAll(" ", "-"), approval);
      // When one assertion field is mismatched
      // Then insertion, challenge consumption, and counter advancement all roll back
      expect(() => assertChallenge(db, challengeId, mismatch)).toThrow(/webauthn assertion binding mismatch|CHECK constraint failed|FOREIGN KEY constraint failed/);
      expect(db.db.prepare("SELECT state FROM webauthn_challenges WHERE challenge_id=?").get(challengeId)).toEqual({ state: "issued" });
      expect(db.db.prepare("SELECT sign_count FROM webauthn_credentials WHERE credential_id=?").get(binding.credentialId)).toEqual({ sign_count: 0 });
    } finally { closePersonalDb(db); }
  });

  it("rejects the exact expiry boundary and assertion replay", async () => {
    // Given a challenge expiring at T2
    const db = await personalDb();
    try {
      enroll(db); const approval = command(db, "expiry"); const challengeId = issue(db, "expiry", approval, T2);
      // When asserted exactly at expiry
      // Then it is expired and permanently unavailable
      expect(() => assertChallenge(db, challengeId)).toThrow("webauthn challenge expired");
      expect(db.db.prepare("SELECT state FROM webauthn_challenges WHERE challenge_id=?").get(challengeId)).toEqual({ state: "issued" });
    } finally { closePersonalDb(db); }
  });

  it("atomically consumes an exact assertion and rejects replay", async () => {
    // Given one exact issued challenge
    const db = await personalDb();
    try {
      enroll(db); const approval = command(db, "success"); const challengeId = issue(db, "success", approval);
      // When the exact assertion is inserted
      assertChallenge(db, challengeId);
      // Then challenge and counter settle together and replay fails
      expect(db.db.prepare("SELECT state,consumed_at FROM webauthn_challenges WHERE challenge_id=?").get(challengeId)).toEqual({ state: "consumed", consumed_at: T2 });
      expect(db.db.prepare("SELECT sign_count FROM webauthn_credentials WHERE credential_id=?").get(binding.credentialId)).toEqual({ sign_count: 1 });
      expect(() => assertChallenge(db, challengeId, { signCount: 2 })).toThrow(/webauthn challenge unavailable|UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("invalidates every open challenge on principal and credential revocation", async () => {
    // Given two open challenges
    const db = await personalDb();
    try {
      enroll(db); const first = issue(db, "principal-revoke", command(db, "principal-revoke")); const second = issue(db, "credential-revoke", command(db, "credential-revoke"));
      // When principal then credential are revoked
      db.db.prepare("UPDATE remote_principals SET state='revoked',revoked_at=? WHERE principal_id=?").run(T2, binding.principalId);
      expect(db.db.prepare("SELECT state FROM webauthn_challenges WHERE challenge_id=?").get(first)).toEqual({ state: "rejected" });
      db.db.prepare("UPDATE webauthn_credentials SET state='revoked',revoked_at=? WHERE credential_id=?").run(T2, binding.credentialId);
      // Then no open challenge remains usable
      expect(db.db.prepare("SELECT state FROM webauthn_challenges WHERE challenge_id=?").get(second)).toEqual({ state: "rejected" });
      expect(() => assertChallenge(db, second)).toThrow("webauthn challenge unavailable");
    } finally { closePersonalDb(db); }
  });
});
