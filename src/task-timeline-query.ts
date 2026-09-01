import type { AuthorityDb } from "./db.js";
import { values, type Row } from "./task-timeline-model.js";

export class TaskTimelineQuery {
  constructor(private readonly authority: AuthorityDb) {}

  rows(sql: string, ...params: unknown[]): Row[] {
    return this.authority.db.prepare<unknown[], Row>(sql).all(...params);
  }

  row(sql: string, ...params: unknown[]): Row | undefined {
    return this.authority.db.prepare<unknown[], Row>(sql).get(...params);
  }

  inRows(sqlPrefix: string, ids: Iterable<string>, sqlSuffix = ""): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = items.map(() => "?").join(",");
    return this.rows(`${sqlPrefix} (${placeholders}) ${sqlSuffix}`, ...items);
  }

  totalChanges(): number {
    return Number(this.row("SELECT total_changes() AS count")?.count ?? 0);
  }
}
