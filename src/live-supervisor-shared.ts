import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
export type Row = Record<string, unknown>;
export const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export const id = (prefix: string, value: unknown) => `${prefix}_${digest(value).slice(7)}`;
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function liveSupervisorTransaction<T>(authority: AuthorityDb, fn: () => T): T {
  authority.db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    authority.db.exec("COMMIT");
    return value;
  } catch (error) {
    authority.db.exec("ROLLBACK");
    throw error;
  }
}
