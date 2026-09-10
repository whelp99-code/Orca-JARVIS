import type { AuthorityDb } from "./db.js";
import { values, type Row } from "./task-timeline-model.js";

export class TaskTimelineQuery {
  constructor(private readonly authority: Pick<AuthorityDb, "db">) {}

  rows(sql: string, ...params: unknown[]): Row[] {
    return this.authority.db.prepare<unknown[], Row>(sql).all(...params);
  }

  row(sql: string, ...params: unknown[]): Row | undefined {
    return this.authority.db.prepare<unknown[], Row>(sql).get(...params);
  }

  inRows(sqlPrefix: string, ids: Iterable<string>, sqlSuffix = ""): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = "SELECT value FROM json_each(?)";
    return this.rows(`${sqlPrefix} (${placeholders}) ${sqlSuffix}`, JSON.stringify(items));
  }

  totalChanges(): number {
    return Number(this.row("SELECT total_changes() AS count")?.count ?? 0);
  }
}

/** Preserve query order for each lookup key, including rows matching multiple keys. */
export function groupTimelineRows(rows: readonly Row[], columns: readonly string[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const keys = new Set(columns.map(column => row[column]).filter((key): key is string => typeof key === "string"));
    for (const key of keys) {
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }
  }
  return groups;
}
