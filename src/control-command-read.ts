import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { ActionLevel, ControlCommandState, StoredControlCommand } from "./control-plane-contract.js";

/** Reads never initialize projections or renew command authority. */
export function readControlCommand(authority: AuthorityDb, requestId: string): StoredControlCommand | undefined {
  const row = authority.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?")
    .get(requestId) as Record<string, unknown> | undefined;
  if (row === undefined || !visibleCommand(row, new MemoryProjectionAuthority(authority))) return undefined;
  return decodeStoredControlCommand(row);
}

export function listControlCommands(authority: AuthorityDb): StoredControlCommand[] {
  const projections = new MemoryProjectionAuthority(authority);
  return (authority.db.prepare("SELECT * FROM control_command_requests ORDER BY requested_at,request_id")
    .all() as Array<Record<string, unknown>>)
    .filter(row => visibleCommand(row, projections)).map(row => decodeStoredControlCommand(row));
}

function visibleCommand(row: Record<string, unknown>, projections: MemoryProjectionAuthority): boolean {
  return !projections.isSuppressed({
    kind: "control_payload", id: String(row.request_id), component_id: String(row.request_id),
  });
}

export function decodeStoredControlCommand(row: Record<string, unknown>): StoredControlCommand {
  return {
    schema_version: 1, request_id: String(row.request_id), action: String(row.action),
    action_level: Number(row.action_level) as ActionLevel,
    target: JSON.parse(String(row.target_json)) as Record<string, unknown>,
    args: JSON.parse(String(row.args_json)) as Record<string, unknown>,
    command_digest: String(row.command_digest), reversible: Boolean(row.reversible),
    requested_by: String(row.requested_by), requested_at: String(row.requested_at),
    expires_at: String(row.expires_at), nonce: String(row.nonce), state: String(row.state) as ControlCommandState,
  };
}
