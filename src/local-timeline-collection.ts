import { createHash, randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { isPersistenceTime } from "./personal-persistence-values.js";
import { TaskTimeline } from "./task-timeline.js";

/** Actual local database read. This does not attest a worktree or remote runtime state. */
export class LocalTimelineCollection {
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date()) {}

  collect(taskId: string) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9:._/-]{1,256}$/.test(taskId)) {
      throw new JarvisError("LOCAL_COLLECTION_TASK_INVALID");
    }
    if (this.authority.db.inTransaction) throw new JarvisError("LOCAL_COLLECTION_TRANSACTION_ACTIVE");
    const startedAt = this.timestamp();
    const context = this.authority.db.transaction(() =>
      new TaskTimeline(this.authority).context(taskId, 1000, 128 * 1024, new Date(startedAt)),
    ).deferred();
    const completedAt = this.timestamp();
    if (completedAt < startedAt || Date.parse(completedAt) - Date.parse(startedAt) >= 300000) {
      throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    }
    if (!isPersistenceTime(context.task.updated_at) || context.task.updated_at > startedAt
      || context.events.some(event => !isPersistenceTime(event.created_at) || event.created_at > startedAt)) {
      throw new JarvisError("LOCAL_COLLECTION_SOURCE_TIME_INVALID");
    }
    // The canonical text fixes the collected bytes; callers cannot mutate nested context objects.
    const contextJson = canonicalize(context);
    const contentDigest = `sha256:${createHash("sha256").update(contextJson).digest("hex")}`;
    return Object.freeze({ schema_version: 1 as const, source_kind: "local_task_timeline" as const,
      collection_id: `collection:${randomUUID()}`, task_id: taskId,
      started_at: startedAt, completed_at: completedAt, source_updated_at: context.task.updated_at,
      state: context.truncated ? "capped" as const : "completed" as const,
      context_json: contextJson, content_digest: contentDigest });
  }

  private timestamp(): string {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    const timestamp = value.toISOString();
    if (!isPersistenceTime(timestamp)) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    return timestamp;
  }
}
