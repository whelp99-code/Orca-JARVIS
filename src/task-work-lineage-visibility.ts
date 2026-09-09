import type { AuthorityDb } from "./db.js";
import type { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { parseTaskWorkLineage } from "./task-work-lineage.js";
import { JarvisError } from "./db.js";

/** Resolve late ancestor suppression without recursion or writes. Excess depth is unavailable. */
export function visibleTaskWorkLineage(db: AuthorityDb, row: Record<string, unknown>, projections: MemoryProjectionAuthority): boolean {
  if (row.action !== "task.execute") return true;
  let current = row;
  const visited = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    const args = JSON.parse(String(current.args_json));
    if (!args || !Object.hasOwn(args, "work_lineage")) return true;
    let lineage;
    try { lineage = parseTaskWorkLineage(args.work_lineage); }
    catch (error) { if (error instanceof JarvisError) return false; throw error; }
    if (lineage.kind === "original") return true;
    if (visited.has(lineage.prior_request_id)) return false;
    visited.add(lineage.prior_request_id);
    const prior = db.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
      .get(lineage.prior_request_id) as Record<string, unknown> | undefined;
    if (!prior || prior.action !== "task.execute" || prior.command_digest !== lineage.prior_command_digest
      || String(prior.requested_at) >= String(current.requested_at)
      || projections.isSuppressed({ kind: "control_payload", id: lineage.prior_request_id, component_id: lineage.prior_request_id })) return false;
    const target = JSON.parse(String(prior.target_json));
    if (typeof target?.task_id !== "string" || projections.isProjectionIdSuppressed(target.task_id)) return false;
    current = prior;
  }
  return false;
}
