import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { CompanyDailyReportError, type CompanyDailyReportCard, type CompanyDailyReportDocument,
  type CompanyDailyReportCounts, type CompanyDailyReportRow, type CompanyDailyReportSummary, type CompanyReportNotificationState,
  type CompanyReportScope } from "./company-daily-report-types.js";
import type { AuthorityDb } from "./db.js";
import { expireUnclaimedNotifications } from "./notification-intent-expiry.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
export const companyReportDigest = (document: CompanyDailyReportDocument): string => `sha256:${hash(document)}`;
export function companyReportId(scope: CompanyReportScope, reportDate: string, cutoffFrom: string, cutoffTo: string): string {
  return `company-report:v1:${hash({ scope, report_date: reportDate, cutoff_from: cutoffFrom, cutoff_to: cutoffTo })}`;
}
export function companyReportDeepLink(reportId: string): string {
  return `/approvals/company-reports/${encodeURIComponent(reportId)}`;
}
type InsertInput = {
  readonly document: CompanyDailyReportDocument;
  readonly preview: string;
  readonly publishedAt: string;
};
type Inserted = { readonly created: true; readonly report_id: string } | { readonly created: false; readonly report_id: string };
export class CompanyDailyReportStore {
  constructor(private readonly db: AuthorityDb, private readonly clock: () => Date = () => new Date()) {}
  insert(input: InsertInput): Inserted {
    const document = input.document;
    const reportId = companyReportId(
      { provider: document.provider, workspace: document.workspace },
      document.report_date, document.cutoff_from, document.cutoff_to,
    );
    const digest = companyReportDigest(document);
    const json = canonicalize(document);
    const intentId = `ntf:pos:v1:${hash({ kind: "company_daily_report", report_id: reportId })}`;
    const expiresAt = new Date(Date.parse(input.publishedAt) + 7 * 86_400_000).toISOString();
    return this.db.db.transaction(() => {
      const existing = this.db.db.prepare(
        `SELECT report_id, report_digest FROM company_daily_reports
         WHERE provider=? AND workspace=? AND report_date=?`,
      ).get(document.provider, document.workspace, document.report_date) as
        { readonly report_id: string; readonly report_digest: string } | undefined;
      if (existing !== undefined) {
        if (existing.report_id === reportId && existing.report_digest === digest) return { created: false, report_id: reportId };
        throw new CompanyDailyReportError("COMPANY_REPORT_DIGEST_CONFLICT");
      }
      if (this.db.db.prepare(
        "SELECT 1 FROM company_daily_reports WHERE provider=? AND workspace=? AND report_date>? LIMIT 1",
      ).get(document.provider, document.workspace, document.report_date)) {
        throw new CompanyDailyReportError("COMPANY_REPORT_DATE_OUT_OF_ORDER");
      }
      this.db.db.prepare(
        `INSERT INTO company_daily_reports(report_id,provider,workspace,report_date,cutoff_from,cutoff_to,report_digest,report_json,published_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(reportId, document.provider, document.workspace, document.report_date, document.cutoff_from, document.cutoff_to,
        digest, json, input.publishedAt);
      this.db.db.prepare(
        `INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
         redacted_preview,deep_link,state,expires_at,created_at,updated_at)
         VALUES(?,?,?,?, 'info','mac', ?, ?, 'created', ?, ?, ?)`,
      ).run(intentId, reportId, `idem:notification:v1:${hash({ report_id: reportId })}`,
        `notification:company-report:v1:${reportId}`, input.preview, companyReportDeepLink(reportId),
        expiresAt, input.publishedAt, input.publishedAt);
      this.db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id=?")
        .run(input.publishedAt, intentId);
      this.db.db.prepare(
        `INSERT INTO company_report_notifications(report_id,intent_id,state,delivery_receipt) VALUES(?,?,'pending',NULL)`,
      ).run(reportId, intentId);
      return { created: true, report_id: reportId };
    }).immediate();
  }
  reportIdFor(scope: CompanyReportScope, reportDate: string): string | undefined {
    const row = this.db.db.prepare(
      `SELECT report_id FROM company_daily_reports WHERE provider=? AND workspace=? AND report_date=?`,
    ).get(scope.provider, scope.workspace, reportDate) as { readonly report_id: string } | undefined;
    return row?.report_id;
  }
  latestCutoff(scope: CompanyReportScope, beforeDate: string): { readonly cutoff_to: string; readonly to_global_sequence: number } | undefined {
    const row = this.db.db.prepare(
      `SELECT cutoff_to, report_json FROM company_daily_reports WHERE provider=? AND workspace=? AND report_date<?
       ORDER BY report_date DESC LIMIT 1`,
    ).get(scope.provider, scope.workspace, beforeDate) as { readonly cutoff_to: string; readonly report_json: string } | undefined;
    if (row === undefined) return undefined;
    const parsed: unknown = JSON.parse(row.report_json);
    const sequence = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "to_global_sequence") : undefined;
    if (typeof sequence !== "number") throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
    return { cutoff_to: row.cutoff_to, to_global_sequence: sequence };
  }
  listCards(): readonly CompanyDailyReportSummary[] {
    expireUnclaimedNotifications(this.db, this.clock().toISOString());
    const rows = this.db.db.prepare(
      `SELECT r.report_id, json_remove(r.report_json,'$.rows') AS report_json, n.state FROM company_daily_reports r
       JOIN company_report_notifications n ON n.report_id=r.report_id
       ORDER BY r.report_date DESC, r.report_id LIMIT 30`,
    ).all() as readonly { readonly report_id: string; readonly report_json: string; readonly state: string }[];
    return rows.map(row => summary(row.report_id, JSON.parse(row.report_json), notificationState(row.state)));
  }
  card(reportId: string): CompanyDailyReportCard | undefined {
    expireUnclaimedNotifications(this.db, this.clock().toISOString());
    const row = this.db.db.prepare(
      `SELECT r.report_json, n.state FROM company_daily_reports r
       JOIN company_report_notifications n ON n.report_id=r.report_id WHERE r.report_id=?`,
    ).get(reportId) as { readonly report_json: string; readonly state: string } | undefined;
    return row === undefined ? undefined : card(reportId, row.report_json, notificationState(row.state));
  }
  markNotification(intentId: string, state: CompanyReportNotificationState, receipt: string | null): void {
    this.db.db.prepare(
      `UPDATE company_report_notifications SET state=?, delivery_receipt=? WHERE intent_id=?`,
    ).run(state, receipt, intentId);
  }
}
function notificationState(value: string): CompanyReportNotificationState {
  if (value === "pending" || value === "unsupported" || value === "delivered" || value === "failed") return value;
  throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
}
function card(reportId: string, json: string, state: CompanyReportNotificationState): CompanyDailyReportCard {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
  const rows = Reflect.get(parsed, "rows");
  if (!Array.isArray(rows)) {
    throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
  }
  return { ...summary(reportId, parsed, state), rows: rows as readonly CompanyDailyReportRow[] };
}
function summary(reportId: string, parsed: unknown, state: CompanyReportNotificationState): CompanyDailyReportSummary {
  if (typeof parsed !== "object" || parsed === null) throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
  const counts = Reflect.get(parsed, "counts");
  if (counts === null || typeof counts !== "object") throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
  return {
    report_id: reportId,
    report_date: text(parsed, "report_date"),
    cutoff_from: text(parsed, "cutoff_from"),
    cutoff_to: text(parsed, "cutoff_to"),
    counts: counts as CompanyDailyReportCounts,
    notification_state: state,
  };
}
function text(value: object, key: string): string {
  const field = Reflect.get(value, key);
  if (typeof field !== "string") throw new CompanyDailyReportError("COMPANY_REPORT_UNAVAILABLE");
  return field;
}
