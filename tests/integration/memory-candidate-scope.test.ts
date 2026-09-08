import { expect, it } from "vitest";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";
import { verifiedMemoryInput, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore, memoryTableCounts } from "../fixtures/memory-candidate-store.js";

it("binds a proposed project scope to persisted verified candidate provenance without granting or writing", async () => {
  const db = await memoryDatabase();
  try {
    const input = verifiedMemoryInput(); seedMemoryAuthority(db.authority, input);
    const candidate = memoryCandidateStore(db.authority).classify(input);
    const counts = memoryTableCounts(db.authority);
    const now = new Date(MEMORY_NOW);
    const scope = { owner: "principal:owner" as const, projects: ["project:a"], policy_revision: "policy:1",
      valid_until: new Date(now.getTime() + 60000).toISOString() };
    const first = proposeMemoryCandidateScope(db.authority, candidate.candidate_id, scope, now);
    expect(first).toMatchObject({ authorization: "not_granted", candidate_digest: candidate.candidate_digest,
      classification_digest: candidate.classification_digest, source_digest: candidate.source_digest });
    const other = proposeMemoryCandidateScope(db.authority, candidate.candidate_id, { ...scope, projects: ["project:b"] }, now);
    expect(other.proposal_digest).not.toBe(first.proposal_digest);
    expect(proposeMemoryCandidateScope(db.authority, candidate.candidate_id, scope, now)).toEqual(first);
    scope.projects.push("project:b"); expect(first.scope.projects).toEqual(["project:a"]);
    expect(Object.isFrozen(first.scope.projects)).toBe(true);
    expect(memoryTableCounts(db.authority)).toEqual(counts);
    expect(readMemoryCandidate(db.authority.db, candidate.candidate_id)).toEqual(candidate);
    for (const projects of [["*"], ["project:b", "project:a"], ["project:a", "project:a"]]) {
      expect(() => proposeMemoryCandidateScope(db.authority, candidate.candidate_id, { ...scope, projects }, now)).toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    }
    expect(() => proposeMemoryCandidateScope(db.authority, candidate.candidate_id,
      { ...scope, valid_until: now.toISOString() }, now)).toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    expect(() => proposeMemoryCandidateScope(db.authority, 'memcand:pos:v1:' + '0'.repeat(64), scope, now)).toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    const expiredAt = new Date(candidate.candidate_expires_at);
    expect(() => proposeMemoryCandidateScope(db.authority, candidate.candidate_id,
      { ...scope, valid_until: new Date(expiredAt.getTime() + 60000).toISOString() }, expiredAt))
      .toThrow("MEMORY_CANDIDATE_SCOPE_INVALID");
    expect(() => db.authority.db.prepare("UPDATE memory_candidate_classifications SET classification_digest=? WHERE candidate_id=?")
      .run("0".repeat(64), candidate.candidate_id)).toThrow("immutable memory candidate classification");
    expect(readMemoryCandidate(db.authority.db, candidate.candidate_id)).toEqual(candidate);
  } finally { closeMemoryDatabase(db); }
});
