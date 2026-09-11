import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCandidateReview } from "../../src/dashboard/memory-candidate-review.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import {
  candidateTaskSource, candidateTaskSourceSuppressed, recordCandidateTaskSource,
} from "../../src/memory-candidate-task-source.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { hasSecondBrainWriteAuthority } from "../../src/second-brain-write-authority.js";
import type { SecondBrainRememberWriteRequest } from "../../src/second-brain-adapter-types.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

const TASK = "task:memory-source";
const NOW = new Date(MEMORY_NOW);
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

async function fixture() {
  const database = await memoryDatabase();
  open.push(database);
  const reviewRoot = join(database.root, "review");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const candidate = store.classify(inferredMemoryInput({ sensitivity: "personal" }));
  return { authority: database.authority, reviewRoot, candidateId: candidate.candidate_id };
}

const hide = (authority: MemoryDatabase["authority"], id: string): void =>
  new MemoryProjectionAuthority(authority)
    .quarantineUnresolved({ kind: "task_timeline", id, component_id: id }, NOW);

/** Only the candidate id is read before the refusal, which is the point being pinned. */
const writeRequest = (candidateId: string): SecondBrainRememberWriteRequest =>
  ({ candidate_id: candidateId } as unknown as SecondBrainRememberWriteRequest);

it("refuses to derive a candidate from a task the owner already hid", async () => {
  const f = await fixture();
  hide(f.authority, TASK);

  expect(() => recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW))
    .toThrow("MEMORY_CANDIDATE_TASK_SOURCE_SUPPRESSED");
  // Refused rather than recorded and filtered later: nothing binds the hidden task.
  expect(candidateTaskSource(f.authority, f.candidateId)).toBeNull();
}, 60_000);

it("closes the review and the write when the task is hidden after the candidate exists", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);
  expect(candidateTaskSource(f.authority, f.candidateId)).toBe(TASK);
  expect(readCandidateReview(f.authority, f.reviewRoot, f.candidateId, NOW)).toBeDefined();

  hide(f.authority, TASK);

  expect(candidateTaskSourceSuppressed(f.authority, f.candidateId)).toBe(true);
  expect(readCandidateReview(f.authority, f.reviewRoot, f.candidateId, NOW)).toBeUndefined();
  expect(hasSecondBrainWriteAuthority(f.authority, writeRequest(f.candidateId), NOW)).toBe(false);
}, 60_000);

it("leaves a candidate that never named a task readable", async () => {
  const f = await fixture();
  hide(f.authority, TASK);

  // No binding, so nothing to withdraw: hiding an unrelated task changes nothing here.
  expect(candidateTaskSourceSuppressed(f.authority, f.candidateId)).toBe(false);
  expect(readCandidateReview(f.authority, f.reviewRoot, f.candidateId, NOW)).toBeDefined();
}, 60_000);

it("binds one task once and refuses to be pointed somewhere else", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);

  // A second run must not re-aim an existing candidate at a task that is still visible.
  expect(() => recordCandidateTaskSource(f.authority, f.candidateId, "task:other", NOW)).toThrow();
  expect(candidateTaskSource(f.authority, f.candidateId)).toBe(TASK);
  expect(() => f.authority.db.prepare(
    "UPDATE memory_candidate_task_sources SET task_id=? WHERE candidate_id=?")
    .run("task:other", f.candidateId)).toThrow("immutable memory candidate task source");
  expect(() => f.authority.db.prepare(
    "DELETE FROM memory_candidate_task_sources WHERE candidate_id=?")
    .run(f.candidateId)).toThrow("immutable memory candidate task source");
}, 60_000);
