import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { ActionLevel, ControlCommandState, StoredControlCommand } from "./control-plane-contract.js";
import { visibleTaskWorkLineage, withVisibleControlCommandReader } from "./task-work-lineage-visibility.js";

/** Reads never initialize projections or renew command authority. */
export function readControlCommand(authority: AuthorityDb, requestId: string): StoredControlCommand | undefined {
  const projections = new MemoryProjectionAuthority(authority);
  projections.assertReady();
  const row = authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
    .get(requestId) as Record<string, unknown> | undefined;
  if (row === undefined || !visibleCommand(row, projections) || !visibleTaskWorkLineage(authority, row, projections)) return undefined;
  return decodeStoredControlCommand(row);
}

export function listControlCommands(authority: AuthorityDb): StoredControlCommand[] {
  return withVisibleControlCommandReader(authority, read => {
    const result: StoredControlCommand[] = [];
    // Keep the legacy array result, without also retaining every raw JSON row and an index of it.
    const ids = authority.db.prepare<[], { request_id: string }>(
      "SELECT request_id FROM control_command_requests ORDER BY requested_at,request_id").iterate();
    for (const candidate of ids) {
      const row = read(String(candidate.request_id));
      if (row) result.push(decodeStoredControlCommand(row));
    }
    return result;
  });
}

function visibleCommand(row: Record<string, unknown>, projections: MemoryProjectionAuthority): boolean {
  return !projections.isSuppressed({
    kind: "control_payload", id: String(row.request_id), component_id: String(row.request_id),
  });
}

export function decodeStoredControlCommand(row: Record<string, unknown>): StoredControlCommand {
  const action = String(row.action);
  const schemaVersion = Number(row.schema_version);
  const stored = {
    request_id: String(row.request_id), action,
    action_level: Number(row.action_level) as ActionLevel,
    target: JSON.parse(String(row.target_json)) as Record<string, unknown>,
    args: JSON.parse(String(row.args_json)) as Record<string, unknown>,
    command_digest: String(row.command_digest), reversible: Boolean(row.reversible),
    requested_by: String(row.requested_by), requested_at: String(row.requested_at),
    expires_at: String(row.expires_at), nonce: String(row.nonce), state: String(row.state) as ControlCommandState,
  };
  if (schemaVersion === 2 && action === "company.candidate.transition") {
    return { ...stored, schema_version: 2, action: "company.candidate.transition" };
  }
  if (schemaVersion !== 1) throw new JarvisError("CONTROL_COMMAND_INVALID");
  return { ...stored, schema_version: 1 };
}
