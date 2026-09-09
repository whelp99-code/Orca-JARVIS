import { JarvisError } from "./db.js";

export type TaskWorkLineage = { readonly schema_version: 1; readonly kind: "original" }
  | { readonly schema_version: 1; readonly kind: "rework" | "retry";
    readonly prior_request_id: string; readonly prior_command_digest: string };

export function parseTaskWorkLineage(value: unknown): TaskWorkLineage {
  const invalid = (): never => { throw new JarvisError("TASK_WORK_LINEAGE_INVALID"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  const keys = row.kind === "original" ? ["kind", "schema_version"]
    : ["kind", "prior_command_digest", "prior_request_id", "schema_version"];
  if (Object.keys(row).sort().join(",") !== keys.join(",") || row.schema_version !== 1) return invalid();
  if (row.kind === "original") return { schema_version: 1, kind: "original" };
  if ((row.kind !== "rework" && row.kind !== "retry") || typeof row.prior_request_id !== "string"
    || row.prior_request_id.trim().length === 0 || row.prior_request_id.length > 160
    || [...row.prior_request_id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || typeof row.prior_command_digest !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(row.prior_command_digest)) return invalid();
  return { schema_version: 1, kind: row.kind, prior_request_id: row.prior_request_id,
    prior_command_digest: row.prior_command_digest };
}
