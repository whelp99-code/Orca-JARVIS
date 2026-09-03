import { describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/index.js";
import { closePersonalDb, digest, insertApproval, legacyRemoteAuthDb as personalDb, T0, T1, T2, T3, T5, type ApprovalFixture, type StoredApproval } from "./personal-operations-test-helpers.js";

const deletionIdentity = {
  deletionId: "del:bound",
  subjectDigest: digest("1"),
  scopeDigest: digest("2"),
  targetDigest: digest("3"),
  argsDigest: digest("4"),
} as const;

function deletionApproval(db: AuthorityDb, suffix: string, overrides: Partial<ApprovalFixture> = {}): StoredApproval {
  return insertApproval(db, {
    suffix,
    action: "memory.delete",
    target: {
      deletion_id: deletionIdentity.deletionId,
      subject_digest: deletionIdentity.subjectDigest,
      scope_digest: deletionIdentity.scopeDigest,
      target_digest: deletionIdentity.targetDigest,
    },
    args: { operation: "forget", args_digest: deletionIdentity.argsDigest },
    ...overrides,
  });
}

function insertRequestedDeletion(db: AuthorityDb, suffix: string): void {
  db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(deletionIdentity.deletionId, `corr:${suffix}`, `idem:${suffix}`, "forget", deletionIdentity.subjectDigest, deletionIdentity.scopeDigest, deletionIdentity.targetDigest, deletionIdentity.argsDigest, "local-owner", "requested", 0, T5, T0, T0);
}

function approveDeletion(db: AuthorityDb, approval: StoredApproval): void {
  db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,updated_at=? WHERE deletion_id=?").run(approval.requestId, approval.receiptId, approval.receiptDigest, T1, deletionIdentity.deletionId);
}

const deletionMismatches = [
  ["wrong subject", { target: { deletion_id: deletionIdentity.deletionId, subject_digest: digest("a"), scope_digest: deletionIdentity.scopeDigest, target_digest: deletionIdentity.targetDigest } }],
  ["wrong scope", { target: { deletion_id: deletionIdentity.deletionId, subject_digest: deletionIdentity.subjectDigest, scope_digest: digest("a"), target_digest: deletionIdentity.targetDigest } }],
  ["wrong target digest", { target: { deletion_id: deletionIdentity.deletionId, subject_digest: deletionIdentity.subjectDigest, scope_digest: deletionIdentity.scopeDigest, target_digest: digest("a") } }],
  ["wrong args digest", { args: { operation: "forget", args_digest: digest("a") } }],
  ["wrong signer", { signer: "remote-owner" }],
  ["remote session", { sessionId: "session:remote" }],
  ["denied receipt", { decision: "reject" as const }],
  ["expired request", { requestExpiresAt: T1 }],
  ["expired receipt", { receiptExpiresAt: T1 }],
] as const;

describe("deletion and tombstone authority remediation", () => {
  it("rejects direct approved insertion even with an unrelated receipt", async () => {
    // Given an unrelated valid approval
    const db = await personalDb();
    try {
      const approval = deletionApproval(db, "direct", { target: { deletion_id: "del:other", subject_digest: digest("a"), scope_digest: digest("b"), target_digest: digest("c") } });
      // When deletion is inserted directly after the requested state
      // Then persistence rejects the authority bypass
      expect(() => db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,confirmation_request_id,confirmation_receipt_id,confirmation_receipt_digest,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(deletionIdentity.deletionId, "corr:direct", "idem:direct", "forget", deletionIdentity.subjectDigest, deletionIdentity.scopeDigest, deletionIdentity.targetDigest, deletionIdentity.argsDigest, "local-owner", "approved", approval.requestId, approval.receiptId, approval.receiptDigest, 0, T5, T0, T0)).toThrow("memory deletion must start requested");
    } finally { closePersonalDb(db); }
  });

  it.each(deletionMismatches)("rejects deletion approval with %s", async (_name, overrides) => {
    // Given a requested deletion and a mismatched authority receipt
    const db = await personalDb();
    try {
      insertRequestedDeletion(db, "mismatch");
      const approval = deletionApproval(db, "mismatch", overrides);
      // When approval is attached
      // Then exact authority binding fails closed
      expect(() => approveDeletion(db, approval)).toThrow("memory deletion approval required");
    } finally { closePersonalDb(db); }
  });

  it("makes deletion authority bindings immutable and single-use", async () => {
    // Given one exactly approved deletion
    const db = await personalDb();
    try {
      insertRequestedDeletion(db, "immutable");
      const approval = deletionApproval(db, "immutable");
      approveDeletion(db, approval);
      // When a validated authority binding is swapped or replayed
      // Then both operations fail closed
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET confirmation_receipt_digest=? WHERE deletion_id=?").run(digest("f"), deletionIdentity.deletionId)).toThrow("immutable memory deletion authority");
      expect(() => db.db.prepare("INSERT INTO memory_deletion_requests(deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("del:replay", "corr:replay", "idem:replay", "forget", digest("a"), digest("b"), digest("c"), digest("d"), "local-owner", "requested", 0, T5, T0, T0)).not.toThrow();
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='approved',confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,updated_at=? WHERE deletion_id='del:replay'").run(approval.requestId, approval.receiptId, approval.receiptDigest, T1)).toThrow(/memory deletion approval required|UNIQUE constraint failed/);
    } finally { closePersonalDb(db); }
  });

  it("rejects a tombstone with any mismatched authority binding", async () => {
    // Given an applying exactly approved deletion
    const db = await personalDb();
    try {
      insertRequestedDeletion(db, "tombstone-mismatch"); const approval = deletionApproval(db, "tombstone-mismatch"); approveDeletion(db, approval);
      db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, deletionIdentity.deletionId);
      db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='delete:new',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id=?").run(T3, T1, deletionIdentity.deletionId);
      // When the tombstone target digest differs
      // Then exact tombstone authority fails closed
      expect(() => db.db.prepare("INSERT INTO memory_tombstones(tombstone_id,deletion_id,subject_digest,scope_digest,target_digest,args_digest,approval_request_id,approval_receipt_id,approval_receipt_digest,effect_lease_owner,effect_lease_fence,effective_at,tombstone_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("tmb:mismatch", deletionIdentity.deletionId, deletionIdentity.subjectDigest, deletionIdentity.scopeDigest, digest("a"), deletionIdentity.argsDigest, approval.requestId, approval.receiptId, approval.receiptDigest, "delete:new", 1, T2, digest("b"), T2)).toThrow("memory tombstone authority required");
    } finally { closePersonalDb(db); }
  });

  it("requires a matching tombstone before settlement", async () => {
    // Given an applying exactly approved deletion
    const db = await personalDb();
    try {
      insertRequestedDeletion(db, "settle"); const approval = deletionApproval(db, "settle"); approveDeletion(db, approval);
      db.db.prepare("UPDATE memory_deletion_requests SET state='queued',updated_at=? WHERE deletion_id=?").run(T1, deletionIdentity.deletionId);
      db.db.prepare("UPDATE memory_deletion_requests SET state='applying',lease_owner='delete:new',lease_fence=1,lease_expires_at=?,updated_at=? WHERE deletion_id=?").run(T3, T1, deletionIdentity.deletionId);
      // When settlement skips tombstone persistence
      // Then both state skipping and direct settlement fail closed
      expect(() => db.db.prepare("UPDATE memory_deletion_requests SET state='settled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE deletion_id=?").run(T2, deletionIdentity.deletionId)).toThrow("memory deletion transition invalid");
    } finally { closePersonalDb(db); }
  });
});

const enrollmentIdentity = {
  principalId: "rpr:bound",
  subjectDigest: digest("5"),
  publicKeyDigest: digest("6"),
  targetDigest: digest("7"),
  argsDigest: digest("8"),
  ownerSessionId: "session:local-owner",
} as const;

function enrollmentApproval(db: AuthorityDb, suffix: string, overrides: Partial<ApprovalFixture> = {}): StoredApproval {
  return insertApproval(db, {
    suffix,
    action: "remote.principal.enroll",
    target: { principal_id: enrollmentIdentity.principalId, subject_digest: enrollmentIdentity.subjectDigest, public_key_digest: enrollmentIdentity.publicKeyDigest, target_digest: enrollmentIdentity.targetDigest },
    args: { operation: "enroll", args_digest: enrollmentIdentity.argsDigest, local_owner_session_id: enrollmentIdentity.ownerSessionId },
    ...overrides,
  });
}

function principalValues(approval: StoredApproval, overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { principalId: enrollmentIdentity.principalId, subjectDigest: enrollmentIdentity.subjectDigest, publicKeyDigest: enrollmentIdentity.publicKeyDigest, targetDigest: enrollmentIdentity.targetDigest, argsDigest: enrollmentIdentity.argsDigest, ownerSessionId: enrollmentIdentity.ownerSessionId, receiptDigest: approval.receiptDigest, ...overrides };
}

function insertActivePrincipal(db: AuthorityDb, approval: StoredApproval): void {
  const value = principalValues(approval, {});
  db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,credential_public_key_digest,target_digest,args_digest,local_owner_session_id,enrollment_request_id,enrollment_receipt_id,enrollment_receipt_digest,enrollment_expires_at,activated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(value.principalId, "active", value.subjectDigest, value.publicKeyDigest, value.targetDigest, value.argsDigest, value.ownerSessionId, approval.requestId, approval.receiptId, value.receiptDigest, T5, T1, T0);
}

function activatePrincipal(db: AuthorityDb, approval: StoredApproval, overrides: Readonly<Record<string, unknown>> = {}): void {
  const value = principalValues(approval, overrides);
  db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES(?,?,?,?)").run(value.principalId, "absent", value.subjectDigest, T0);
  db.db.prepare("UPDATE remote_principals SET state='active',credential_public_key_digest=?,target_digest=?,args_digest=?,local_owner_session_id=?,enrollment_request_id=?,enrollment_receipt_id=?,enrollment_receipt_digest=?,enrollment_expires_at=?,activated_at=? WHERE principal_id=?").run(value.publicKeyDigest, value.targetDigest, value.argsDigest, value.ownerSessionId, approval.requestId, approval.receiptId, value.receiptDigest, T5, T1, value.principalId);
}

const enrollmentMismatches = [
  ["wrong signer", { signer: "remote-owner" }, {}],
  ["wrong session", { sessionId: "session:remote" }, {}],
  ["wrong subject", {}, { subjectDigest: digest("a") }],
  ["wrong public key", {}, { publicKeyDigest: digest("a") }],
  ["wrong target", {}, { targetDigest: digest("a") }],
  ["wrong args", {}, { argsDigest: digest("a") }],
  ["wrong receipt digest", {}, { receiptDigest: digest("a") }],
  ["denied receipt", { decision: "reject" as const }, {}],
  ["expired receipt", { receiptExpiresAt: T1 }, {}],
] as const;

describe("remote enrollment authority remediation", () => {
  it("requires the absent principal state before exact activation", async () => {
    // Given exact local enrollment authority
    const db = await personalDb();
    try {
      const approval = enrollmentApproval(db, "direct-active");
      // When an active principal is inserted directly
      // Then the absent-to-active lifecycle cannot be skipped
      expect(() => insertActivePrincipal(db, approval)).toThrow("remote principal must start absent");
    } finally { closePersonalDb(db); }
  });

  it.each(enrollmentMismatches)("rejects enrollment with %s", async (_name, approvalOverrides, principalOverrides) => {
    // Given mismatched local enrollment authority
    const db = await personalDb();
    try {
      const approval = enrollmentApproval(db, "mismatch", approvalOverrides);
      // When principal activation is attempted
      // Then the exact owner enrollment binding rejects it
      expect(() => activatePrincipal(db, approval, principalOverrides)).toThrow("remote principal enrollment required");
    } finally { closePersonalDb(db); }
  });
});
