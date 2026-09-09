import { createHash } from "node:crypto";
import { type AuthorityDb, JarvisError } from "./db.js";
import { decodeStoredControlCommand } from "./control-command-read.js";
import { withVisibleControlCommandReader } from "./task-work-lineage-visibility.js";
import type { StoredControlCommand } from "./control-plane-contract.js";

type Anchor = { position: string; request_id: string; requested_at: string; command_digest: string };
const digest = (row: Anchor) => createHash("sha256")
  .update(JSON.stringify([row.requested_at, row.request_id, row.command_digest])).digest("hex");
const invalid = (): never => { throw new JarvisError("VALIDATION_ERROR"); };
function decode(value: string): [string, string] {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.toString("base64url") !== value) return invalid();
    const key = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "string" || typeof key[1] !== "string"
      || !/^-?(0|[1-9]\d{0,18})$/.test(key[0]) || !/^[0-9a-f]{64}$/.test(key[1])) return invalid();
    return key as [string, string];
  } catch { return invalid(); }
}

/** Current visibility in one snapshot; at most 500 candidate commands per call. */
export function pageControlCommands(db: AuthorityDb, limit = 100, cursor?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalid();
  const key = cursor === undefined ? undefined : decode(cursor);
  return withVisibleControlCommandReader(db, read => {
    let anchor: Anchor | undefined;
    if (key) {
      anchor = db.db.prepare(`SELECT CAST(rowid AS TEXT) position,request_id,requested_at,command_digest
        FROM control_command_requests WHERE rowid=?`).get(key[0]) as Anchor | undefined;
      if (!anchor || digest(anchor) !== key[1]) throw new JarvisError("CONTROL_PAGE_STALE");
    }
    const rows = db.db.prepare(`SELECT CAST(rowid AS TEXT) position,request_id,requested_at,command_digest
      FROM control_command_requests ${anchor ? "WHERE (requested_at,request_id)>(?,?)" : ""}
      ORDER BY requested_at,request_id LIMIT 501`).all(...(anchor ? [anchor.requested_at, anchor.request_id] : [])) as Anchor[];
    const requests: StoredControlCommand[] = [];
    let scanned = 0;
    while (scanned < Math.min(rows.length, 500) && requests.length < limit) {
      const row = rows[scanned++]!;
      const command = read(row.request_id);
      if (command) requests.push(decodeStoredControlCommand(command));
    }
    const hasMore = scanned < rows.length;
    const last = rows[scanned - 1];
    return { requests, page: { limit, returned: requests.length, scanned, has_more: hasMore,
      next_cursor: hasMore && last ? Buffer.from(JSON.stringify([last.position, digest(last)])).toString("base64url") : null } };
  });
}
