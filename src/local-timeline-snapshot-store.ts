import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { LocalTimelineCollection } from "./local-timeline-collection.js";
import { isPersistenceTime } from "./personal-persistence-values.js";
import { TaskTimeline } from "./task-timeline.js";

type Snapshot = ReturnType<LocalTimelineCollection["collect"]>;
type Row = { task_id: string; generation: number; held: number; snapshot_json: string | null; collection_id: string | null; expires_at: string | null };
const fail = (code: string): never => { throw new JarvisError(code); };
const validId = (id: string): boolean => typeof id === "string" && /^[A-Za-z0-9:._/-]{1,256}$/.test(id);

/** Bounded disposable cache. No execution authority or remote liveness is implied. */
export class LocalTimelineSnapshotStore {
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date()) {}

  register(taskId: string): void {
    if (!validId(taskId)) return fail("LOCAL_COLLECTION_TASK_INVALID");
    this.authority.db.transaction(() => {
      if (this.row(taskId)) return;
      this.authority.db.prepare("INSERT INTO local_timeline_subjects(task_id) VALUES(?)").run(taskId);
    }).immediate();
  }

  setHeld(taskId: string, held: boolean): void {
    if (!validId(taskId) || typeof held !== "boolean") return fail("LOCAL_COLLECTION_TASK_INVALID");
    this.authority.db.transaction(() => {
      if (!this.row(taskId)) return fail("LOCAL_COLLECTION_UNREGISTERED");
      this.authority.db.prepare(`UPDATE local_timeline_subjects SET held=?,generation=generation+1,snapshot_json=NULL,
        collection_id=NULL,expires_at=NULL WHERE task_id=?`).run(held ? 1 : 0, taskId);
    }).immediate();
  }

  refresh(taskId: string): Snapshot {
    const subject = this.requireSubject(taskId);
    const snapshot = new LocalTimelineCollection(this.authority, this.clock).collect(taskId);
    return this.authority.db.transaction(() => {
      if (this.requireSubject(taskId).generation !== subject.generation) return fail("LOCAL_COLLECTION_SOURCE_CHANGED");
      const now = this.timestamp();
      if (now < snapshot.completed_at || Date.parse(now) >= Date.parse(snapshot.started_at) + 300000) {
        return fail("LOCAL_COLLECTION_CLOCK_INVALID");
      }
      // Recheck the actual source under the admission lock; no caller-supplied snapshot is admitted.
      if (canonicalize(new TaskTimeline(this.authority).context(taskId, 1000, 128 * 1024,
        new Date(snapshot.started_at))) !== snapshot.context_json) return fail("LOCAL_COLLECTION_SOURCE_CHANGED");
      const expires = new Date(Date.parse(snapshot.started_at) + 300000).toISOString();
      const encoded = canonicalize(snapshot);
      if (Buffer.byteLength(encoded, "utf8") > 262144) return fail("LOCAL_COLLECTION_SNAPSHOT_TOO_LARGE");
      const finished = this.timestamp();
      if (finished < now || finished >= expires) return fail("LOCAL_COLLECTION_CLOCK_INVALID");
      this.authority.db.prepare(`UPDATE local_timeline_subjects SET snapshot_json=?,collection_id=?,expires_at=?
        WHERE task_id=?`).run(encoded, snapshot.collection_id, expires, taskId);
      return snapshot;
    }).immediate();
  }

  read(taskId: string, collectionId: string) {
    const now = this.timestamp();
    return this.authority.db.transaction(() => {
      const row = this.row(taskId);
      const unavailable = (reason: string) => ({ state: "unavailable" as const, reason });
      if (!row) return unavailable("unregistered");
      if (row.held) return unavailable("held");
      if (!row.snapshot_json || row.collection_id !== collectionId) return unavailable("snapshot_missing");
      const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
      if (canonicalize(snapshot) !== row.snapshot_json || snapshot.schema_version !== 1
        || snapshot.source_kind !== "local_task_timeline" || snapshot.task_id !== taskId
        || snapshot.collection_id !== collectionId || !isPersistenceTime(snapshot.started_at)
        || !isPersistenceTime(snapshot.completed_at) || snapshot.started_at > snapshot.completed_at
        || row.expires_at !== new Date(Date.parse(snapshot.started_at) + 300000).toISOString()
        || typeof snapshot.context_json !== "string"
        || snapshot.content_digest !== `sha256:${createHash("sha256").update(snapshot.context_json).digest("hex")}`) {
        return fail("LOCAL_COLLECTION_STORED_INVALID");
      }
      if (now < snapshot.completed_at || now >= row.expires_at) return unavailable("stale");
      if (snapshot.state === "capped") return unavailable("capped");
      if (snapshot.state !== "completed") return fail("LOCAL_COLLECTION_STORED_INVALID");
      try {
        const current = new TaskTimeline(this.authority).context(taskId, 1000, 128 * 1024, new Date(snapshot.started_at));
        if (snapshot.source_updated_at !== current.task.updated_at
          || canonicalize(current) !== snapshot.context_json) return unavailable("source_changed");
      } catch (error) {
        if (error instanceof JarvisError && error.code === "TASK_TIMELINE_NOT_FOUND") return unavailable("source_missing");
        throw error;
      }
      const finished = this.timestamp();
      if (finished < now || finished >= row.expires_at) return unavailable("stale");
      return { state: "ready" as const, snapshot: Object.freeze(snapshot), expires_at: row.expires_at };
    }).deferred();
  }

  expire(): number {
    const now = this.timestamp();
    return this.authority.db.prepare(`UPDATE local_timeline_subjects SET snapshot_json=NULL,collection_id=NULL,expires_at=NULL
      WHERE expires_at<=?`).run(now).changes;
  }

  private timestamp(): string {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail("LOCAL_COLLECTION_CLOCK_INVALID");
    const value = now.toISOString();
    if (!isPersistenceTime(value)) return fail("LOCAL_COLLECTION_CLOCK_INVALID");
    return value;
  }

  private row(taskId: string): Row | undefined {
    if (!validId(taskId)) return fail("LOCAL_COLLECTION_TASK_INVALID");
    return this.authority.db.prepare("SELECT * FROM local_timeline_subjects WHERE task_id=?").get(taskId) as Row | undefined;
  }

  private requireSubject(taskId: string): Row {
    const row = this.row(taskId);
    if (!row) return fail("LOCAL_COLLECTION_UNREGISTERED");
    if (row.held) return fail("LOCAL_COLLECTION_HELD");
    return row;
  }
}
