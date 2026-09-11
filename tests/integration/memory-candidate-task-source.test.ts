import { dirname, join } from "node:path";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { readCandidateReview } from "../../src/dashboard/memory-candidate-review.js";
import {
  stageMemoryCandidateDecision, type MemoryCandidateDecisionHost,
} from "../../src/dashboard/memory-candidate-decision-staging.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import {
  candidateTaskSource, candidateTaskSourceSuppressed, memoriesAwaitingTaskWithdrawal,
  recordCandidateTaskSource,
} from "../../src/memory-candidate-task-source.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { sanitizeMemoryRestoreCandidate } from "../../src/memory-restore-high-water.js";
import { AuthorityDb } from "../../src/db.js";
import {
  hasDispatchedScopedSourceAuthority, hasRegisteredScopedSourceAuthority,
  hasSecondBrainWriteAuthority,
} from "../../src/second-brain-write-authority.js";
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
  // The same gate stands in front of scoped registration and of an already dispatched write, so
  // hiding the task closes the queue and the send, not only the first write attempt.
  expect(hasRegisteredScopedSourceAuthority(f.authority, writeRequest(f.candidateId),
    "outbox:memory:unused", NOW)).toBe(false);
  expect(hasDispatchedScopedSourceAuthority(f.authority, writeRequest(f.candidateId),
    "outbox:memory:unused", 1, NOW)).toBe(false);
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

it("takes the binding with the candidate when a rebuild removes it", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);
  const fresh = `${f.authority.filename}.rebuilt`;

  // A blocked candidate deletes its parent row, so a binding left behind would dangle and the
  // rebuild would refuse. It does not, because the copier filters every table carrying a
  // candidate_id by the blocked set; this pins that the new table inherits that rule rather than
  // needing one of its own.
  const build = await buildFreshAuthority(f.authority, fresh, {
    blocked_projections: [{ kind: "candidate", id: f.candidateId, component_id: f.candidateId }],
    sensitive_material: [],
  });
  expect(build.foreign_key_errors).toBe(0);
  expect(build.integrity_check).toBe("ok");

  const rebuilt = new AuthorityDb(fresh);
  try {
    expect(rebuilt.db.prepare("SELECT COUNT(*) FROM memory_candidate_task_sources").pluck().get())
      .toBe(0);
    expect(rebuilt.db.prepare("SELECT COUNT(*) FROM memory_candidates WHERE candidate_id=?")
      .pluck().get(f.candidateId)).toBe(0);
  } finally {
    rebuilt.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${fresh}${suffix}`, { force: true });
  }
}, 60_000);

it("keeps a task hidden after a backup taken before it was hidden is restored", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);
  const backup = `${f.authority.filename}.backup`;
  f.authority.db.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(f.authority.filename, backup);

  // Hidden only after the backup exists, which is the case a restore could undo.
  hide(f.authority, TASK);

  const restore = await sanitizeMemoryRestoreCandidate({ authority: f.authority, source: backup,
    workspace: join(dirname(backup), "restore-workspace"), now: NOW });
  expect(restore.disposition).toBe("sanitized");
  expect(restore.activated).toBe(false);
  const path = restore.sanitized_path;
  expect(path).not.toBeNull();
  const restored = new AuthorityDb(String(path));
  try {
    // The binding travels with the candidate, and the hiding travels with the current authority,
    // so the restored database answers the same way this one does.
    expect(candidateTaskSource(restored, f.candidateId)).toBe(TASK);
    expect(candidateTaskSourceSuppressed(restored, f.candidateId)).toBe(true);
    expect(readCandidateReview(restored, f.reviewRoot, f.candidateId, NOW)).toBeUndefined();
  } finally {
    restored.close();
  }
}, 60_000);

it("lists what a hidden task still has stored, and only that", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);
  // Nothing is outstanding while the task is visible, whatever was stored from it.
  expect(memoriesAwaitingTaskWithdrawal(f.authority)).toEqual([]);

  hide(f.authority, TASK);

  const outstanding = memoriesAwaitingTaskWithdrawal(f.authority);
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]).toMatchObject({ candidate_id: f.candidateId, task_id: TASK });
  expect(String(outstanding[0]?.content_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
  // Nothing reached the provider yet, so there is no target a withdrawal could name.
  expect(outstanding[0]).toMatchObject({ target_id: null, target_digest: null });

  // Once the provider holds a copy, the entry carries the exact target to act on.
  const digest = String(outstanding[0]?.content_digest);
  f.authority.db.prepare(
    `INSERT INTO memory_resolved_target_metadata(target_id,target_digest,provider_instance_id,
      generation_id,generation_manifest_digest,page_content_digest,source_identity_digest,
      content_identity_digest,citation_identity_digest,keyed_subject_digest,sensitivity,
      source_owner_class,source_owner_id_digest,resolved_at,expires_at,created_at)
     VALUES(?,?,'provider:test','generation:1',?,?,?,?,?,?,'personal','provider_owned',?,?,?,?)`,
  ).run("target:test", `${digest}0`, digest, digest, digest, digest, digest, digest, digest,
    MEMORY_NOW, "2026-08-29T12:00:00.000Z", MEMORY_NOW);
  expect(memoriesAwaitingTaskWithdrawal(f.authority)[0])
    .toMatchObject({ target_id: "target:test", target_digest: `${digest}0` });

  // The list clears when the owner-approved suppression lands; this test does not forge one, so
  // what it pins is the reporting rule and its scope, not the withdrawal itself.
  const unbound = await fixture();
  hide(unbound.authority, TASK);
  expect(memoriesAwaitingTaskWithdrawal(unbound.authority)).toEqual([]);
}, 60_000);

it("refuses to confirm a decision prepared before the task was hidden", async () => {
  const f = await fixture();
  recordCandidateTaskSource(f.authority, f.candidateId, TASK, NOW);
  // Only the authority and the clock are read before the refusal this pins.
  const bare = { options: { authority: f.authority, clock: () => NOW } };
  const host = bare as unknown as MemoryCandidateDecisionHost;
  const decision = { candidate_id: f.candidateId, decision: "confirm" as const,
    operation: "remember" as const, actor: "principal:owner", token: "token" };

  // Visible: the refusal below is not what stops it, so it gets as far as the candidate's own state.
  expect(() => stageMemoryCandidateDecision(host, decision as never))
    .not.toThrow("MEMORY_CANDIDATE_SUPPRESSED");

  hide(f.authority, TASK);

  expect(() => stageMemoryCandidateDecision(host, decision as never))
    .toThrow("MEMORY_CANDIDATE_SUPPRESSED");
}, 60_000);

it("commits no candidate at all when admission names a hidden task", async () => {
  const database = await memoryDatabase();
  open.push(database);
  hide(database.authority, TASK);
  const reviewRoot = join(database.root, "review");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);

  expect(() => store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_CANDIDATE_TASK_SOURCE_SUPPRESSED");

  // The binding shares the candidate's transaction, so a refusal leaves nothing to read, approve
  // or account for later.
  expect(database.authority.db.prepare("SELECT COUNT(*) FROM memory_candidates").pluck().get()).toBe(0);
  expect(database.authority.db.prepare("SELECT COUNT(*) FROM memory_candidate_task_sources")
    .pluck().get()).toBe(0);
  expect(existsSync(reviewRoot) ? readdirSync(reviewRoot) : []).toEqual([]);
}, 60_000);
