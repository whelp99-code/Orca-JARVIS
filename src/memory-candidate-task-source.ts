import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import {
  assertCandidateProjectInScope, taskProjectOutOfScope,
} from "./memory-candidate-project-scope.js";
import { TaskTimelinePopulation } from "./task-timeline-population.js";

/**
 * Binds a candidate to the task whose work produced it.
 *
 * Recorded at admission, and refused outright when that task is already hidden: a summary of a
 * hidden task must not exist as a candidate at all, rather than exist and be filtered later. The
 * check runs in the same transaction as the write, so a task hidden between the check and the
 * insert cannot leave a binding behind.
 */
export function recordCandidateTaskSource(
  authority: AuthorityDb, candidateId: string, taskId: string, now: Date,
): void {
  authority.db.transaction(() => bindCandidateTaskSource(authority, candidateId, taskId, now))
    .immediate();
}

/**
 * The same binding for a caller that already holds the write transaction.
 *
 * Admission uses this so the candidate and its binding commit or roll back together: a candidate
 * that is refused because its task is hidden must not exist at all, not exist unbound.
 */
export function bindCandidateTaskSource(
  authority: AuthorityDb, candidateId: string, taskId: string, now: Date,
): void {
  if (taskSuppressed(authority, taskId)) {
    throw new JarvisError("MEMORY_CANDIDATE_TASK_SOURCE_SUPPRESSED");
  }
  // Every binding passes here - admission through the store and any later recording alike - so
  // this is where the owner's project policy is applied rather than at one of the callers.
  assertCandidateProjectInScope(authority, taskId);
  authority.db.prepare(
    "INSERT INTO memory_candidate_task_sources(candidate_id,task_id,recorded_at) VALUES(?,?,?)")
    .run(candidateId, taskId, now.toISOString());
}

/** The task this candidate was derived from, when one was recorded. */
export function candidateTaskSource(authority: AuthorityDb, candidateId: string): string | null {
  const value = authority.db.prepare(
    "SELECT task_id FROM memory_candidate_task_sources WHERE candidate_id=?").pluck().get(candidateId);
  return typeof value === "string" ? value : null;
}

/**
 * True when the candidate's originating task is hidden now.
 *
 * Consumption asks this again rather than trusting admission: a task hidden after a candidate was
 * created must close the read, the owner decision and the write, not only the intake that already
 * happened. A candidate with no recorded task is unaffected, which is what keeps candidates that
 * never came from a task readable.
 */
export function candidateTaskSourceSuppressed(authority: AuthorityDb, candidateId: string): boolean {
  const taskId = candidateTaskSource(authority, candidateId);
  return taskId !== null && taskSuppressed(authority, taskId);
}

/**
 * True when the originating task closes this candidate to reading, sending or approval.
 *
 * Two separate reasons, asked at every consumption rather than only at admission, because both can
 * become true after a candidate exists: the owner can hide the task, and the owner can write or
 * narrow the project policy. A candidate with no recorded task is closed by neither.
 */
export function candidateTaskSourceClosed(authority: AuthorityDb, candidateId: string): boolean {
  const taskId = candidateTaskSource(authority, candidateId);
  return taskId !== null && (taskSuppressed(authority, taskId)
    || taskProjectOutOfScope(authority, taskId));
}

/**
 * True when a derived memory with this content identity came from a task that is closed now.
 *
 * The provider owns the record identity, so a stored copy is matched the way the withdrawal list
 * matches one: by the content identity its candidate carries. Material no candidate here produced
 * is unaffected, which keeps memory that never came from a task readable.
 */
export function derivedMemoryTaskClosed(authority: AuthorityDb, contentDigest: string): boolean {
  const rows = authority.db.prepare(
    `SELECT t.task_id AS task_id FROM memory_candidate_task_sources t
     JOIN memory_candidates c ON c.candidate_id=t.candidate_id
     WHERE replace(c.content_digest,'sha256:','')=replace(?,'sha256:','')`).all(contentDigest);
  return rows.some(row => {
    if (row === null || typeof row !== "object") return false;
    const taskId = String(Reflect.get(row, "task_id"));
    return taskSuppressed(authority, taskId) || taskProjectOutOfScope(authority, taskId);
  });
}

export type MemoryAwaitingWithdrawal = {
  readonly candidate_id: string;
  readonly task_id: string;
  readonly content_digest: string;
  /** The provider target a withdrawal would act on, or null when nothing was stored yet. */
  readonly target_id: string | null;
  readonly target_digest: string | null;
};

/**
 * Derived memories that are already stored and whose task the owner has since hidden.
 *
 * Withdrawing a stored memory is an owner-approved effect, so nothing here writes one: hiding a
 * task closes every path that would read, approve or send the candidate, but a copy that already
 * left for the provider can only be taken back through the existing suppression and tombstone
 * route. This is the list that route has to be pointed at, and an empty list is the evidence that
 * nothing is outstanding.
 *
 * A stored copy is matched the way the restore path matches one: by the content identity the
 * suppression records carry, because the provider owns the record identity and this database does
 * not store it. The same identity reaches the resolved target metadata, so each entry carries the
 * target a withdrawal would name; a null target means nothing reached the provider and there is
 * nothing out there to take back.
 */
export function memoriesAwaitingTaskWithdrawal(
  authority: AuthorityDb,
): readonly MemoryAwaitingWithdrawal[] {
  const rows = authority.db.prepare(
    `SELECT t.candidate_id AS candidate_id,t.task_id AS task_id,c.content_digest AS content_digest,
       r.target_id AS target_id,r.target_digest AS target_digest
     FROM memory_candidate_task_sources t
     JOIN memory_candidates c ON c.candidate_id=t.candidate_id
     LEFT JOIN memory_resolved_target_metadata r
       ON replace(r.content_identity_digest,'sha256:','')=replace(c.content_digest,'sha256:','')
     WHERE NOT EXISTS (SELECT 1 FROM memory_suppressions s WHERE s.state='active'
       AND replace(c.content_digest,'sha256:','')=replace(s.content_identity_digest,'sha256:',''))
     ORDER BY t.task_id,t.candidate_id`).all();
  return rows.flatMap(row => {
    if (row === null || typeof row !== "object") return [];
    const taskId = String(Reflect.get(row, "task_id"));
    return taskSuppressed(authority, taskId)
      ? [{ candidate_id: String(Reflect.get(row, "candidate_id")), task_id: taskId,
        content_digest: String(Reflect.get(row, "content_digest")),
        target_id: text(Reflect.get(row, "target_id")),
        target_digest: text(Reflect.get(row, "target_digest")) }]
      : [];
  });
}

const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function taskSuppressed(authority: AuthorityDb, taskId: string): boolean {
  return new TaskTimelinePopulation(authority).isSuppressed(taskId);
}
