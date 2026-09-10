import { JarvisError, type AuthorityDb } from "./db.js";
import { LocalTimelineSnapshotStore } from "./local-timeline-snapshot-store.js";

/** Opt-in local collection. Counts describe this cycle, not a durable readiness receipt. */
export class LocalTimelineRefreshService {
  private previousAt = 0;
  private cursor = "";
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date = () => new Date()) {}

  cycle() {
    const started = this.now();
    // Durable claim: a restart or a duplicate process must not collect again inside the window.
    if (!this.claim(started)) return undefined;
    const store = new LocalTimelineSnapshotStore(this.authority, this.clock);
    const expired = store.expire();
    const rows = this.authority.db.prepare("SELECT task_id,held FROM local_timeline_subjects ORDER BY task_id LIMIT 65")
      .all() as { task_id: string; held: number }[];
    if (rows.length > 64) throw new JarvisError("LOCAL_COLLECTION_CAPACITY");
    const ordered = [...rows.filter(row => row.task_id > this.cursor), ...rows.filter(row => row.task_id <= this.cursor)];
    let attempted = 0, collected = 0, capped = 0, failed = 0, held = 0;
    for (const row of ordered) {
      const now = this.now();
      // Synchronous source reads cannot be interrupted; this budget is checked between tasks.
      if (now - started >= 30000) break;
      this.cursor = row.task_id; attempted++;
      if (row.held) { held++; continue; }
      try {
        const result = store.refresh(row.task_id);
        if (result.state === "capped") capped++; else collected++;
      } catch { failed++; }
    }
    this.now();
    const remaining = rows.length - attempted;
    return { source_kind: "local_task_timeline" as const, status: rows.length === 0 ? "no_data" : remaining || failed || capped ? "partial" : "processed",
      subjects: rows.length, attempted, collected, capped, failed, held, remaining, expired };
  }

  /** Claims the cycle window in one write. Uses the caller's instant; adds no clock read. */
  private claim(started: number): boolean {
    const at = new Date(started).toISOString();
    const next = new Date(started + 60000).toISOString();
    return this.authority.db.transaction(() => {
      const current = this.authority.db.prepare(
        "SELECT next_at FROM local_timeline_cycle_fence WHERE fence_id=1").pluck().get();
      if (typeof current === "string" && at < current) return false;
      this.authority.db.prepare(
        `INSERT INTO local_timeline_cycle_fence(fence_id,next_at,claimed_at) VALUES(1,?,?)
         ON CONFLICT(fence_id) DO UPDATE SET next_at=excluded.next_at,claimed_at=excluded.claimed_at`,
      ).run(next, at);
      return true;
    }).immediate();
  }

  private now(): number {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    const timestamp = value.getTime();
    if (timestamp < this.previousAt) throw new JarvisError("LOCAL_COLLECTION_CLOCK_INVALID");
    this.previousAt = timestamp;
    return timestamp;
  }
}
