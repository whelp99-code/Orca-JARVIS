import { type AuthorityDb, JarvisError } from "./db.js";
import { canonicalize } from "./canonical.js";
import { liveSupervisorTransaction, type Row } from "./live-supervisor-shared.js";
export function liveSupervisorReport(row: Row): { report_id: string; payload_json: string; payload_digest: string } {
  return { report_id: String(row.report_id), payload_json: String(row.payload_json), payload_digest: String(row.payload_digest) };
}

export function acknowledgeLiveReport(authority: AuthorityDb, report_id: string, delivered_at = new Date().toISOString()): void {
  if (!/^live_report_[0-9a-f]{64}$/.test(report_id)) throw new JarvisError("LIVE_REPORT_INVALID");
  liveSupervisorTransaction(authority, () => {
    if (!authority.db.prepare("SELECT 1 FROM live_supervisor_reports WHERE report_id=?").get(report_id))
      throw new JarvisError("LIVE_REPORT_INVALID");
    authority.db
      .prepare("INSERT INTO live_supervisor_report_receipts(report_id,delivered_at) VALUES(?,?) ON CONFLICT(report_id) DO NOTHING")
      .run(report_id, delivered_at);
    const sources = authority.db
      .prepare(
        `SELECT progress_report_id, pre_gjc_report_id FROM live_supervisor_report_sources WHERE report_id=? ORDER BY
          candidate_id`,
      )
      .all(report_id) as Row[];
    for (const source of sources) {
      if (typeof source.progress_report_id === "string")
        authority.db
          .prepare("INSERT INTO progress_delivery_receipts(report_id,delivered_at) VALUES(?,?) ON CONFLICT(report_id) DO NOTHING")
          .run(source.progress_report_id, delivered_at);
      const receipt = canonicalize({ live_report_id: report_id, delivered_at });
      authority.db
        .prepare(
          `UPDATE pre_gjc_report_outbox SET state='delivered', delivered_at=COALESCE(delivered_at, ?),
            receipt_json=COALESCE(receipt_json, ?), lease_owner=NULL, lease_expires_at=NULL WHERE report_id=? AND state IN
            ('pending', 'leased', 'delivered')`,
        )
        .run(delivered_at, receipt, source.pre_gjc_report_id);
    }
  });
}

export function liveSupervisorStatus(authority: AuthorityDb): Record<string, unknown> {
  const count = (table: string) => Number((authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
  return {
    worktrees: count("live_supervisor_worktrees"),
    bindings: count("live_supervisor_bindings"),
    reports_pending: Number(
      (
        authority.db
          .prepare(
            `SELECT COUNT(*) AS count FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts d ON
              d.report_id=r.report_id WHERE d.report_id IS NULL`,
          )
          .get() as Row
      ).count,
    ),
    reports_delivered: Number((authority.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_report_receipts").get() as Row).count),
  };
}
