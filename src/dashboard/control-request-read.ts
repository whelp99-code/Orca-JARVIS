import { JarvisError, type AuthorityDb } from "../db.js";
import { createHash } from "node:crypto";
import { MemoryProjectionAuthority } from "../memory-projection-authority.js";
import type { ActionLevel, ControlCommandState } from "../control-plane-contract.js";
import type { ControlRequestListResponse, OverviewApproval } from "./legacy-read-contracts.js";
import { dashboardRetryStatus } from "./retry-policy.js";
import { CONTROL_LINEAGE_VISIBLE_SQL } from "./control-lineage-visibility-sql.js";

export type ControlPageInput = { readonly limit: number; readonly after?: readonly [string, string] };
const validAnchor = (key: readonly string[]): boolean => key.length === 2
  && /^-?(0|[1-9]\d{0,18})$/.test(key[0] ?? "") && /^[0-9a-f]{64}$/.test(key[1] ?? "");
const anchorDigest = (row: { requested_at: string; request_id: string; command_digest: string }): string =>
  createHash("sha256").update(JSON.stringify([row.requested_at, row.request_id, row.command_digest])).digest("hex");
const ACTIONABLE = "c.state IN ('pending','approved','failed')";
// Exact parity with isSuppressed(control_payload, request_id, request_id).
const VISIBLE = `NOT EXISTS (SELECT 1 FROM memory_projection_quarantine q
  WHERE q.projection_kind='control_payload' AND q.projection_id=c.request_id AND q.component_id=c.request_id)
  AND NOT EXISTS (SELECT 1 FROM memory_projection_suppressions s
  WHERE s.projection_kind='control_payload' AND s.projection_id=c.request_id AND s.component_id=c.request_id)
  AND ${CONTROL_LINEAGE_VISIBLE_SQL}`;
const SELECT = `SELECT CAST(c.rowid AS TEXT) AS position,c.command_digest,
  c.request_id,c.action,c.action_level,c.requested_at,c.requested_by,c.state,
  CASE WHEN c.action='task.execute' AND json_type(c.target_json,'$.task_id')='text'
    THEN json_extract(c.target_json,'$.task_id') ELSE NULL END AS task_id,
  CASE WHEN c.action='workflow.start' AND c.state='failed' THEN c.args_json ELSE '{}' END AS retry_args
  FROM control_command_requests c`;
type Row = { position: string; command_digest: string; request_id: string; action: string; action_level: ActionLevel; requested_at: string;
  requested_by: string; state: ControlCommandState; task_id: string | null; retry_args: string };

function decode(row: Row, now: Date): OverviewApproval {
  return { ...(row.task_id === null ? {} : { task_id: row.task_id }), request_id: row.request_id,
    action: row.action, action_level: row.action_level, requested_at: row.requested_at,
    requested_by: row.requested_by, summary: row.action, state: row.state,
    retry_status: dashboardRetryStatus({ action: row.action, state: row.state,
      args: JSON.parse(row.retry_args) as Record<string, unknown> }, now) };
}

/** No cached authority: every page and count reads the current suppression tables in one read transaction. */
export function controlRequestPage(db: AuthorityDb, now: Date, page?: ControlPageInput): ControlRequestListResponse {
  if (page !== undefined && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
    || (page.after !== undefined && !validAnchor(page.after)))) throw new JarvisError("VALIDATION_ERROR");
  return db.db.transaction(() => {
    new MemoryProjectionAuthority(db).assertReady();
    const where = `${ACTIONABLE} AND ${VISIBLE}`;
    if (page === undefined) {
      // Preserve the unpaged v1 response for existing consumers. New browser requests opt into bounded pages.
      const rows = db.db.prepare(`${SELECT} WHERE ${where} ORDER BY c.requested_at,c.request_id`).all() as Row[];
      return { schema_version: 1 as const, items: rows
        .sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.request_id.localeCompare(b.request_id))
        .map(row => decode(row, now)) };
    }
    const count = db.db.prepare(`SELECT COUNT(*) AS n FROM control_command_requests c WHERE ${where}`).get() as { n: number };
    const anchor = page.after === undefined ? undefined : db.db.prepare(
      "SELECT requested_at,request_id,command_digest FROM control_command_requests WHERE rowid=?",
    ).get(page.after[0]) as { requested_at: string; request_id: string; command_digest: string } | undefined;
    if (page.after !== undefined && (anchor === undefined || anchorDigest(anchor) !== page.after[1])) {
      throw new JarvisError("CONTROL_PAGE_STALE");
    }
    const after = anchor === undefined ? "" : "AND (c.requested_at,c.request_id)>(?,?)";
    const params = anchor === undefined ? [page.limit + 1] : [anchor.requested_at, anchor.request_id, page.limit + 1];
    const rows = db.db.prepare(`${SELECT} INDEXED BY control_command_requests_actionable_page
      WHERE ${where} ${after} ORDER BY c.requested_at,c.request_id LIMIT ?`).all(...params) as Row[];
    const items = rows.slice(0, page.limit).map(row => decode(row, now));
    const last = rows[Math.min(rows.length, page.limit) - 1];
    const hasMore = rows.length > page.limit;
    return { schema_version: 1 as const, items, page: { limit: page.limit, total: count.n,
      returned: items.length, has_more: hasMore, next_cursor: hasMore && last !== undefined
        ? Buffer.from(JSON.stringify([last.position, anchorDigest(last)])).toString("base64url") : null } };
  })();
}

export function pendingControlSummary(db: AuthorityDb, now: Date): { total: number; items: OverviewApproval[] } {
  return db.db.transaction(() => {
    new MemoryProjectionAuthority(db).assertReady();
    const where = `c.state='pending' AND ${VISIBLE}`;
    const count = db.db.prepare(`SELECT COUNT(*) AS n FROM control_command_requests c WHERE ${where}`).get() as { n: number };
    const rows = db.db.prepare(`${SELECT} WHERE ${where} ORDER BY c.requested_at,c.request_id LIMIT 20`).all() as Row[];
    return { total: count.n, items: rows.map(row => decode(row, now)) };
  })();
}

/** A navigation position, never authorization or a frozen snapshot. SQL parameters only. */
export function parseControlPage(url: string | undefined): ControlPageInput | "legacy" | "invalid" {
  const params = new URL(url ?? "/", "http://127.0.0.1").searchParams;
  if (!params.has("limit") && !params.has("cursor")) return "legacy";
  const limit = params.get("limit");
  if (params.getAll("limit").length !== 1 || limit === null || !/^[1-9]\d{0,2}$/.test(limit)
    || Number(limit) > 100 || params.getAll("cursor").length > 1) return "invalid";
  const cursor = params.get("cursor");
  if (cursor === null) return { limit: Number(limit) };
  if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return "invalid";
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return "invalid";
    const key: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(key) || !key.every(value => typeof value === "string") || !validAnchor(key)) return "invalid";
    return { limit: Number(limit), after: key as [string, string] };
  } catch { return "invalid"; }
}
