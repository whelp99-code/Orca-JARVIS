import { JarvisError, type AuthorityDb } from "../db.js";

export type DbRow = Readonly<Record<string, unknown>>;

export function dbRows(value: unknown): readonly DbRow[] {
  if (!Array.isArray(value)) throw new JarvisError("INTERNAL_ERROR");
  return value.map(dbRow);
}

export function dbRow(value: unknown): DbRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JarvisError("INTERNAL_ERROR");
  return Object.fromEntries(Object.entries(value));
}

export function text(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new JarvisError("INTERNAL_ERROR");
  return value;
}

export function nullableText(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new JarvisError("INTERNAL_ERROR");
  return value;
}

export function numberValue(row: DbRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new JarvisError("INTERNAL_ERROR");
  return value;
}

export function readOnlySnapshot<T>(db: AuthorityDb, operation: () => T): T {
  const before = totalChanges(db);
  const output = operation();
  if (totalChanges(db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
  return output;
}

export async function readOnlySnapshotAsync<T>(db: AuthorityDb, operation: () => Promise<T>): Promise<T> {
  const before = totalChanges(db);
  const output = await operation();
  if (totalChanges(db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
  return output;
}

function totalChanges(db: AuthorityDb): number {
  return numberValue(dbRow(db.db.prepare("SELECT total_changes() AS value").get()), "value");
}
