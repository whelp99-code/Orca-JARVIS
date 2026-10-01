import type Database from "better-sqlite3";
import { sourceKey, type Source } from "./contracts.js";

export type SourceInventoryEntry = {
  source_key: string; status: string; page_completeness: string;
  total_kind: string; current_work_total: number | null;
  failure_reason: string | null;
};
/** File rosters are discovery evidence, never a current-work denominator. */
export function coverage(entry: SourceInventoryEntry): "complete" | "unknown" {
  return entry.status === "live" && entry.page_completeness === "complete" &&
    entry.total_kind === "current_work" && entry.current_work_total !== null ? "complete" : "unknown";
}
export function registerSource(db: Database.Database, source: Source, entry: SourceInventoryEntry): void {
  if (entry.source_key !== sourceKey(source)) throw new Error("WORKBOARD_SOURCE_INVALID");
  db.prepare(`INSERT INTO workboard_sources(source_key,coverage,warning) VALUES(?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET coverage=excluded.coverage,warning=excluded.warning`)
    .run(entry.source_key, coverage(entry), entry.failure_reason);
}
