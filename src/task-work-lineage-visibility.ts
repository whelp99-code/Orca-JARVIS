import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { parseTaskWorkLineage } from "./task-work-lineage.js";
import { JarvisError } from "./db.js";

/** Observations are scoped to this transaction; the reader cannot be used after it ends. */
export function withVisibleControlCommandReader<T>(db: AuthorityDb,
  consume: (read: (id: string) => Record<string, unknown> | undefined) => T): T {
  return db.db.transaction(() => {
    const projections = new MemoryProjectionAuthority(db);
    projections.assertReady();
    const rows = new Map<string, Record<string, unknown> | undefined>();
    const payloads = new Map<string, boolean>(), tasks = new Map<string, boolean>();
    const statement = db.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?");
    const read = (id: string) => {
      if (!rows.has(id)) rows.set(id, statement.get(id) as Record<string, unknown> | undefined);
      return rows.get(id);
    };
    const payloadSuppressed = (id: string) => {
      if (!payloads.has(id)) payloads.set(id, projections.isSuppressed({ kind: "control_payload", id, component_id: id }));
      return payloads.get(id)!;
    };
    const taskSuppressed = (id: string) => {
      if (!tasks.has(id)) tasks.set(id, projections.isProjectionIdSuppressed(id));
      return tasks.get(id)!;
    };
    let active = true;
    try {
      return consume(id => {
        if (!active) throw new JarvisError("CONTROL_READ_SNAPSHOT_CLOSED");
        const row = read(id);
        return row && !payloadSuppressed(id) && visible(row, read, payloadSuppressed, taskSuppressed) ? row : undefined;
      });
    } finally { active = false; rows.clear(); payloads.clear(); tasks.clear(); }
  }).deferred();
}

/** Resolve late ancestor suppression without recursion or writes. Excess depth is unavailable. */
export function visibleTaskWorkLineage(db: AuthorityDb, row: Record<string, unknown>, projections: MemoryProjectionAuthority): boolean {
  return visible(row, id => db.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
    .get(id) as Record<string, unknown> | undefined,
  id => projections.isSuppressed({ kind: "control_payload", id, component_id: id }),
  id => projections.isProjectionIdSuppressed(id));
}

/** Caller holds one read transaction. No memoized observation survives this call. */
export function visibleTaskWorkLineageRows(rows: readonly Record<string, unknown>[], projections: MemoryProjectionAuthority) {
  const byId = new Map(rows.map(row => [String(row.request_id), row]));
  const payloads = new Map<string, boolean>(), tasks = new Map<string, boolean>();
  const payloadSuppressed = (id: string) => {
    if (!payloads.has(id)) payloads.set(id, projections.isSuppressed({ kind: "control_payload", id, component_id: id }));
    return payloads.get(id)!;
  };
  const taskSuppressed = (id: string) => {
    if (!tasks.has(id)) tasks.set(id, projections.isProjectionIdSuppressed(id));
    return tasks.get(id)!;
  };
  return rows.filter(row => !payloadSuppressed(String(row.request_id))
    && visible(row, id => byId.get(id), payloadSuppressed, taskSuppressed));
}

function visible(row: Record<string, unknown>, read: (id: string) => Record<string, unknown> | undefined,
  payloadSuppressed: (id: string) => boolean, taskSuppressed: (id: string) => boolean): boolean {
  if (row.action !== "task.execute") return true;
  if (row.target_json !== undefined) {
    const target = JSON.parse(String(row.target_json));
    if (typeof target?.task_id === "string" && taskSuppressed(target.task_id)) return false;
  }
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
    const prior = read(lineage.prior_request_id);
    if (!prior || prior.action !== "task.execute" || prior.command_digest !== lineage.prior_command_digest
      || !Number.isFinite(Date.parse(String(prior.requested_at))) || !Number.isFinite(Date.parse(String(current.requested_at)))
      || Date.parse(String(prior.requested_at)) >= Date.parse(String(current.requested_at))
      || payloadSuppressed(lineage.prior_request_id)) return false;
    const target = JSON.parse(String(prior.target_json));
    if (typeof target?.task_id !== "string" || taskSuppressed(target.task_id)) return false;
    current = prior;
  }
  return false;
}
