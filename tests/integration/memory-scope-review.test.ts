import { expect, it } from "vitest";
import { stageMemoryScopeReview, readApprovedMemoryScopeReview } from "../../src/memory-scope-review.js";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { ControlPlane, signCommandApproval, type StoredControlCommand } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { localKey } from "../helpers.js";
import { verifiedMemoryInput, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore, memoryTableCounts } from "../fixtures/memory-candidate-store.js";
import type { AuthorityDb } from "../../src/db.js";
import { prepareMemoryScopedWriteIdentity } from "../../src/memory-scoped-write-identity.js";
import { prepareMemoryScopedWritePayload, prepareMemoryScopedWriteFromDispatch } from "../../src/memory-scoped-write-payload.js";
import { outboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";

function receipt(authority: AuthorityDb, command: StoredControlCommand, now: Date) {
  return signCommandApproval({ schema_version: 1, receipt_id: `receipt:${command.request_id}`, request_id: command.request_id,
    decision: "approve", command_digest: command.command_digest, signer_principal_id: "principal:owner",
    authenticated_session_id: "scope-review-test", key_id: "decision-test", algorithm: "Ed25519",
    issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: command.expires_at,
    nonce: command.request_id, max_uses: 1, status: "issued" }, localKey(authority));
}

it("binds an existing signed owner approval to the exact scope and denies pending, changed, expired and revoked reviews", async () => {
  const f = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW); const input = verifiedMemoryInput(); seedMemoryAuthority(f.authority, input);
    const candidate = memoryCandidateStore(f.authority).classify(input);
    const scope = { owner: "principal:owner" as const, projects: ["project:a"], policy_revision: "policy:1",
      valid_until: new Date(now.getTime() + 60000).toISOString() };
    const proposal = proposeMemoryCandidateScope(f.authority, candidate.candidate_id, scope, now);
    const command = stageMemoryScopeReview(f.authority, proposal, now);
    const counts = memoryTableCounts(f.authority);
    expect(stageMemoryScopeReview(f.authority, proposal, now)).toEqual(command);
    expect(memoryTableCounts(f.authority)).toEqual(counts);
    expect(() => readApprovedMemoryScopeReview(f.authority, proposal, command.request_id, now)).toThrow("MEMORY_SCOPE_REVIEW_INVALID");
    const control = new ControlPlane(f.authority); control.decide(receipt(f.authority, command, now), now);
    const approvedCounts = memoryTableCounts(f.authority);
    const identity = prepareMemoryScopedWriteIdentity(f.authority, proposal, command.request_id, now);
    const prepared = prepareMemoryScopedWritePayload(f.authority, proposal, command.request_id, input.subject, input.statement, now);
    expect(prepared.payload.content).toBe(input.statement);
    expect(prepared.binding).toEqual(identity);
    expect(prepared.writes_authorized).toBe(false);
    for (const [subject, content] of [[input.subject, "changed outcome"], ["changed subject", input.statement], [input.subject, "\0"]]) {
      expect(() => prepareMemoryScopedWritePayload(f.authority, proposal, command.request_id, subject, content, now))
        .toThrow("MEMORY_SCOPED_PAYLOAD_INVALID");
    }
    expect(memoryTableCounts(f.authority)).toEqual(approvedCounts);
    expect(identity.writes_authorized).toBe(false);
    const later = new Date(now.getTime() + 1);
    const repeated = proposeMemoryCandidateScope(f.authority, candidate.candidate_id, scope, later);
    const repeatedCommand = stageMemoryScopeReview(f.authority, repeated, later);
    control.decide(receipt(f.authority, repeatedCommand, later), later);
    expect(prepareMemoryScopedWriteIdentity(f.authority, repeated, repeatedCommand.request_id, later).idempotency_key)
      .toBe(identity.idempotency_key);
    const afterReapproval = memoryTableCounts(f.authority);
    expect(control.nextApproved(now)).not.toBe(command.request_id);
    expect(() => control.claim(command.request_id, "generic-worker", now)).toThrow("CONTROL_ACTION_REVIEW_ONLY");
    expect(memoryTableCounts(f.authority)).toEqual(afterReapproval);
    expect(readApprovedMemoryScopeReview(f.authority, proposal, command.request_id, now))
      .toMatchObject({ writes_authorized: false, proposal, control_request_id: command.request_id });
    expect(memoryTableCounts(f.authority)).toEqual(afterReapproval);
    const other = proposeMemoryCandidateScope(f.authority, candidate.candidate_id, { ...scope, projects: ["project:b"] }, now);
    expect(stageMemoryScopeReview(f.authority, other, now).command_digest).not.toBe(command.command_digest);
    expect(() => readApprovedMemoryScopeReview(f.authority, other, command.request_id, now)).toThrow("MEMORY_SCOPE_REVIEW_INVALID");
    expect(() => readApprovedMemoryScopeReview(f.authority, proposal, command.request_id, new Date(scope.valid_until)))
      .toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    control.cancel({ request_id: command.request_id, reason: "withdraw scope", actor: "principal:owner", revoked_at: now.toISOString() }, now);
    expect(() => readApprovedMemoryScopeReview(f.authority, proposal, command.request_id, now)).toThrow("MEMORY_SCOPE_REVIEW_INVALID");
    expect(approvedCounts.memory_outbox).toBe(counts.memory_outbox);
  } finally { closeMemoryDatabase(f); }
});

it("prepares from private dispatch bytes and refuses revoked original verification despite a valid scope review", async () => {
  const f = await outboxFixture();
  try {
    const authority = f.database.authority; const now = f.clock.now;
    const candidate = readMemoryCandidate(authority.db, f.request.candidate_id)!;
    const proposal = proposeMemoryCandidateScope(authority, candidate.candidate_id, {
      owner: "principal:owner", projects: ["project:a"], policy_revision: "policy:1",
      valid_until: new Date(now.getTime() + 60000).toISOString() }, now);
    const command = stageMemoryScopeReview(authority, proposal, now);
    const control = new ControlPlane(authority); control.decide(receipt(authority, command, now), now);
    const dispatch = { dispatch_spool_digest: String(control.get(f.commandId)!.args.dispatch_spool_digest),
      roots: { review: `${f.database.root}/candidate-review`, dispatch: `${f.database.root}/candidate-dispatch` } };
    const before = memoryTableCounts(authority);
    expect(prepareMemoryScopedWriteFromDispatch(authority, proposal, command.request_id, dispatch, now).payload.content)
      .toBe(f.request.payload.content);
    expect(memoryTableCounts(authority)).toEqual(before);
    authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
      .run(candidate.source.verification_evidence_id, "withdraw original evidence", now.toISOString());
    const revokedCounts = memoryTableCounts(authority);
    expect(readApprovedMemoryScopeReview(authority, proposal, command.request_id, now).writes_authorized).toBe(false);
    expect(() => prepareMemoryScopedWriteFromDispatch(authority, proposal, command.request_id, dispatch, now))
      .toThrow("MEMORY_SCOPED_SOURCE_AUTHORITY_INVALID");
    expect(memoryTableCounts(authority)).toEqual(revokedCounts);
    expect(f.writer.calls).toHaveLength(0);
  } finally { closeMemoryDatabase(f.database); }
});

it("rechecks quarantine at approval time and rolls back the receipt", async () => {
  const f = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW); const input = verifiedMemoryInput(); seedMemoryAuthority(f.authority, input);
    const candidate = memoryCandidateStore(f.authority).classify(input);
    const proposal = proposeMemoryCandidateScope(f.authority, candidate.candidate_id, {
      owner: "principal:owner", projects: ["project:a"], policy_revision: "policy:1",
      valid_until: new Date(now.getTime() + 60000).toISOString() }, now);
    const command = stageMemoryScopeReview(f.authority, proposal, now);
    const projections = new MemoryProjectionAuthority(f.authority); projections.initialize(now);
    projections.quarantineUnresolved({ kind: "dashboard_projection", id: candidate.candidate_id, component_id: candidate.candidate_id }, now);
    const counts = memoryTableCounts(f.authority);
    expect(() => new ControlPlane(f.authority).decide(receipt(f.authority, command, now), now)).toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    expect(memoryTableCounts(f.authority)).toEqual(counts);
    expect(new ControlPlane(f.authority).get(command.request_id)?.state).toBe("pending");
  } finally { closeMemoryDatabase(f); }
});
