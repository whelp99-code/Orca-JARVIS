import { JarvisError, type AuthorityDb } from "./db.js";
import { LocalTimelineSnapshotStore } from "./local-timeline-snapshot-store.js";

/** Opt-in local collection. Counts describe this cycle, not a durable readiness receipt. */
export class LocalTimelineRefreshService {
  private nextAt = 0;
  private previousAt = 0;
  private cursor = "";
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date()) {}

  cycle() {
    const started = this.now();
    if (started < this.previousAt) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    this.previousAt = started;
    if (started < this.nextAt) return undefined;
    this.nextAt = started + 60000;
    const store = new LocalTimelineSnapshotStore(this.authority, this.clock);
    const expired = store.expire();
    const rows = this.authority.db.prepare("SELECT task_id,held FROM local_timeline_subjects ORDER BY task_id LIMIT 65")
      .all() as { task_id: string; held: number }[];
    if (rows.length > 64) throw new JarvisError("LOCAL_COLLECTION_CAPACITY");
    const ordered = [...rows.filter(row => row.task_id > this.cursor), ...rows.filter(row => row.task_id <= this.cursor)];
    let attempted = 0, collected = 0, capped = 0, failed = 0, held = 0;
    for (const row of ordered) {
      const now = this.now();
      if (now < started) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
      // Synchronous source reads cannot be interrupted; this budget is checked between tasks.
      if (now - started >= 30000) break;
      this.cursor = row.task_id; attempted++;
      if (row.held) { held++; continue; }
      try {
        const result = store.refresh(row.task_id);
        if (result.state === "capped") capped++; else collected++;
      } catch { failed++; }
    }
    const finished = this.now();
    if (finished < started) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    this.previousAt = finished;
    const remaining = rows.length - attempted;
    return { source_kind: "local_task_timeline" as const, status: rows.length === 0 ? "no_data" : remaining || failed || capped ? "partial" : "processed",
      subjects: rows.length, attempted, collected, capped, failed, held, remaining, expired };
  }

  private now(): number {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    return value.getTime();
  }
}
