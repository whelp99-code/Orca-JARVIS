import { expect, it } from "vitest";
import { stageMemoryScopeReview, readApprovedMemoryScopeReview } from "../../src/memory-scope-review.js";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { ControlPlane, signCommandApproval, type StoredControlCommand } from "../../src/control-plane.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { localKey } from "../helpers.js";
import { verifiedMemoryInput, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore, memoryTableCounts } from "../fixtures/memory-candidate-store.js";
import type { AuthorityDb } from "../../src/db.js";

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
    expect(control.nextApproved(now)).not.toBe(command.request_id);
    expect(() => control.claim(command.request_id, "generic-worker", now)).toThrow("CONTROL_ACTION_REVIEW_ONLY");
    expect(memoryTableCounts(f.authority)).toEqual(approvedCounts);
    expect(readApprovedMemoryScopeReview(f.authority, proposal, command.request_id, now))
      .toMatchObject({ writes_authorized: false, proposal, control_request_id: command.request_id });
    expect(memoryTableCounts(f.authority)).toEqual(approvedCounts);
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
