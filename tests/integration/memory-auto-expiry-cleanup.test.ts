import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { cleanupMemoryCandidateReviews } from "../../src/memory-candidate-review-cleanup.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { outboxFixture, claimAction } from "../fixtures/memory-outbox-fixture.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";

it("cleans expired unused automatic source bytes without changing the classified snapshot", async () => {
  const f = await outboxFixture();
  try {
    const root = `${f.database.root}/candidate-review`;
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    expect(cleanupMemoryCandidateReviews(f.database.authority, root, f.clock.now)).toBe(0);
    expect(existsSync(path)).toBe(true);
    f.clock.now = new Date(candidate.candidate_expires_at);
    expect(await f.service.reconcileOnce("expiry-cleanup", 1)).not.toHaveProperty("cleanup_error");
    expect(existsSync(path)).toBe(false);
    expect(readMemoryCandidate(f.database.authority.db, candidate.candidate_id)).toEqual(candidate);
    expect(cleanupMemoryCandidateReviews(f.database.authority, root, f.clock.now)).toBe(0);
    expect(f.writer.calls).toHaveLength(0);
  } finally { closeMemoryDatabase(f.database); }
});

it("preserves queued source bytes past candidate expiry for reconciliation", async () => {
  const f = await outboxFixture();
  try {
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    const root = `${f.database.root}/candidate-review`;
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    f.service.enqueue(claimAction(f));
    expect(cleanupMemoryCandidateReviews(f.database.authority, root, new Date(candidate.candidate_expires_at))).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(() => cleanupMemoryCandidateReviews(f.database.authority, root, new Date(NaN))).toThrow("MEMORY_REVIEW_CLEANUP_CLOCK_INVALID");
    expect(existsSync(path)).toBe(true);
  } finally { closeMemoryDatabase(f.database); }
});
