import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
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
  authority.db.transaction(() => {
    if (taskSuppressed(authority, taskId)) throw new JarvisError("MEMORY_CANDIDATE_TASK_SOURCE_SUPPRESSED");
    authority.db.prepare(
      "INSERT INTO memory_candidate_task_sources(candidate_id,task_id,recorded_at) VALUES(?,?,?)")
      .run(candidateId, taskId, now.toISOString());
  }).immediate();
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

function taskSuppressed(authority: AuthorityDb, taskId: string): boolean {
  return new TaskTimelinePopulation(authority).isSuppressed(taskId);
}
