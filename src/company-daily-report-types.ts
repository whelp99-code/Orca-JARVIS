import { JarvisError } from "./jarvis-error.js";

export const COMPANY_REPORT_CLASSIFICATIONS = [
  "contact_new", "calendar_memo", "progress_memo", "human_required", "conflict", "unresolved",
] as const;
export type CompanyReportClassification = (typeof COMPANY_REPORT_CLASSIFICATIONS)[number];
export type CompanyReportScope = { readonly provider: string; readonly workspace: string };
export type CompanyReportNotificationState = "pending" | "unsupported" | "delivered" | "failed";
export type CompanyDailyReportRow = {
  readonly candidate_id: string;
  readonly classification: CompanyReportClassification;
  readonly status: string;
  readonly mail_event_ref: string;
  readonly policy_version: string;
  readonly processed_at: string | null;
  readonly receipt_id: string | null;
  readonly error_reason: string | null;
  readonly operation_id: string;
  readonly global_sequence: number;
  readonly counts_as_complete: boolean;
};
export type CompanyDailyReportCounts = {
  readonly contact_new: number;
  readonly calendar_memo: number;
  readonly progress_memo: number;
  readonly human_required: number;
  readonly conflict: number;
  readonly unresolved: number;
  readonly completed: number;
};
export type CompanyDailyReportDocument = {
  readonly schema_version: 1;
  readonly provider: string;
  readonly workspace: string;
  readonly report_date: string;
  readonly cutoff_from: string;
  readonly cutoff_to: string;
  readonly epoch: string;
  readonly from_global_sequence: number;
  readonly to_global_sequence: number;
  readonly counts: CompanyDailyReportCounts;
  readonly rows: readonly CompanyDailyReportRow[];
};
/** Lead-owned signed auto-report client implements this. JARVIS never calls SB itself. */
export type CompanyDailyReportRead = {
  readonly scope: CompanyReportScope;
  readonly report_date: string;
  readonly cutoff_from: string;
  readonly cutoff_to: string;
  readonly from_global_sequence: number;
  readonly to_global_sequence: number | null;
  readonly limit: 100;
  readonly cursor: string | null;
};
export type CompanyDailyReportPage = {
  readonly schema_version: 1;
  readonly epoch: string;
  readonly pinned_cutoff: string;
  readonly from_global_sequence: number;
  readonly to_global_sequence: number;
  readonly rows: readonly CompanyDailyReportRow[];
  readonly next_cursor: string | null;
};
export interface CompanyDailyReportSource {
  readPage(request: CompanyDailyReportRead): CompanyDailyReportPage;
}
export type CompanyDailyReportConfig =
  | { readonly enabled: false }
  | {
    readonly enabled: true;
    readonly scope: CompanyReportScope;
    readonly activation_cutoff: string;
    readonly source: CompanyDailyReportSource;
  };
export type CompanyDailyReportCard = {
  readonly report_id: string;
  readonly report_date: string;
  readonly cutoff_from: string;
  readonly cutoff_to: string;
  readonly counts: CompanyDailyReportCounts;
  readonly rows: readonly CompanyDailyReportRow[];
  readonly notification_state: CompanyReportNotificationState;
};
export type CompanyReportPublishResult =
  | { readonly status: "disabled" }
  | { readonly status: "idle" }
  | { readonly status: "published"; readonly report_id: string; readonly created: boolean }
  | { readonly status: "conflict"; readonly report_id: string };
export class CompanyDailyReportError extends JarvisError {
  constructor(code: "COMPANY_REPORT_DIGEST_CONFLICT" | "COMPANY_REPORT_PAGE_INVALID" | "COMPANY_REPORT_UNAVAILABLE") {
    super(code);
  }
}
