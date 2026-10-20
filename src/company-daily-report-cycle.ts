import { KST_OFFSET_MS } from "./daily-loop-time.js";
import { CompanyDailyReportError } from "./company-daily-report-types.js";
import { CompanyDailyReportStore } from "./company-daily-report-store.js";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import type { CompanyDailyReportConfig, CompanyDailyReportCounts, CompanyDailyReportDocument,
  CompanyDailyReportPage, CompanyDailyReportRead, CompanyDailyReportRow, CompanyDailyReportSource,
  CompanyReportClassification, CompanyReportPublishResult, CompanyReportScope } from "./company-daily-report-types.js";

const PAGE_LIMIT = 100 as const;
const CLASSIFICATIONS = new Set<CompanyReportClassification>([
  "contact_new", "calendar_memo", "progress_memo", "human_required", "conflict", "unresolved",
]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SECRET = /(?:@|password|secret|token|bearer|credential|passkey|금액|원\b|KRW|USD|\$)/iu;
const metadata = z.string().refine(safeId);
const rowSchema = z.object({
  candidate_id: metadata, classification: z.enum(["contact_new", "calendar_memo", "progress_memo", "human_required", "conflict", "unresolved"]),
  status: metadata, mail_event_ref: metadata, policy_version: metadata,
  processed_at: z.iso.datetime({ precision: 3 }).nullable(), receipt_id: metadata.nullable(),
  error_reason: metadata.nullable(), operation_id: metadata,
  global_sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER), counts_as_complete: z.boolean(),
}).strict();

export function disabledCompanyReportConfig(): CompanyDailyReportConfig {
  return { enabled: false };
}
export function createDashboardCompanyReportTick(db: AuthorityDb, clock: () => Date,
  config: CompanyDailyReportConfig = disabledCompanyReportConfig()): () => void {
  const cycle = new CompanyDailyReportCycle(db, config);
  return () => { cycle.publishDue(clock()); };
}
export class CompanyDailyReportCycle {
  private active = false;
  constructor(private readonly db: AuthorityDb, private readonly config: CompanyDailyReportConfig) {}
  publishDue(now: Date, publishedAt: Date = now): CompanyReportPublishResult {
    if (!this.config.enabled) return { status: "disabled" };
    if (this.active) return { status: "idle" };
    this.active = true;
    try { return this.publish(now, publishedAt, this.config); }
    finally { this.active = false; }
  }
  private publish(now: Date, publishedAt: Date, config: Extract<CompanyDailyReportConfig, { enabled: true }>): CompanyReportPublishResult {
    const reportDate = dueReportDate(now, config.activation_cutoff);
    if (reportDate === null) return { status: "idle" };
    const store = new CompanyDailyReportStore(this.db);
    const existing = store.reportIdFor(config.scope, reportDate);
    if (existing !== undefined) return { status: "published", report_id: existing, created: false };
    const prior = store.latestCutoff(config.scope, reportDate);
    const cutoffTo = kstCutoff(reportDate);
    const cutoffFrom = prior?.cutoff_to ?? config.activation_cutoff;
    if (Date.parse(cutoffFrom) > Date.parse(cutoffTo)) return { status: "idle" };
    const read = readPages(config.source, {
      scope: config.scope, report_date: reportDate, cutoff_from: cutoffFrom, cutoff_to: cutoffTo,
      from_global_sequence: prior?.to_global_sequence ?? 0, to_global_sequence: null, limit: PAGE_LIMIT, cursor: null,
    });
    const document = documentFrom(config.scope, reportDate, cutoffFrom, cutoffTo, read);
    try {
      const inserted = store.insert({ document, preview: preview(document), publishedAt: publishedAt.toISOString() });
      return { status: "published", report_id: inserted.report_id, created: inserted.created };
    } catch (error) {
      if (error instanceof CompanyDailyReportError && error.code === "COMPANY_REPORT_DIGEST_CONFLICT") {
        return { status: "conflict", report_id: store.reportIdFor(config.scope, reportDate) ?? "" };
      }
      throw error;
    }
  }
}
type ReadResult = { readonly epoch: string; readonly from_global_sequence: number;
  readonly to_global_sequence: number; readonly rows: readonly CompanyDailyReportRow[] };
function readPages(source: CompanyDailyReportSource, first: CompanyDailyReportRead): ReadResult {
  let cursor: string | null = null;
  let epoch: string | undefined;
  let lower: number | undefined;
  let upper: number | undefined;
  const seen = new Set<string>();
  let last: CompanyDailyReportRow | undefined;
  const rows: CompanyDailyReportRow[] = [];
  let bytes = 0;
  for (let page = 0; page < 1_000; page += 1) {
    const result = source.readPage({ ...first, to_global_sequence: upper ?? null, cursor, limit: PAGE_LIMIT });
    acceptPage(result, first, epoch, lower, upper);
    epoch = result.epoch;
    lower = result.from_global_sequence;
    upper = result.to_global_sequence;
    for (const row of result.rows) {
      const key = `${String(row.global_sequence)}\u0000${row.operation_id}`;
      if (seen.has(key)) throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
      if (last !== undefined && (row.global_sequence < last.global_sequence
        || (row.global_sequence === last.global_sequence && row.operation_id <= last.operation_id))) {
        throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
      }
      seen.add(key);
      bytes += Buffer.byteLength(canonicalize(row), "utf8") + 1;
      if (bytes > 1_900_000) throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
      rows.push(row);
      last = row;
    }
    if (result.next_cursor === null) return { epoch, from_global_sequence: lower, to_global_sequence: upper, rows };
    if (result.next_cursor === cursor) throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
    cursor = result.next_cursor;
  }
  throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
}
function acceptPage(page: CompanyDailyReportPage, request: CompanyDailyReportRead, epoch: string | undefined,
  lower: number | undefined, upper: number | undefined): void {
  if (page.schema_version !== 1 || page.pinned_cutoff !== request.cutoff_to
    || !Number.isSafeInteger(page.from_global_sequence) || page.from_global_sequence < 0
    || (request.from_global_sequence !== 0 && page.from_global_sequence !== request.from_global_sequence)
    || (lower !== undefined && page.from_global_sequence !== lower)
    || page.epoch.length === 0 || page.rows.length > PAGE_LIMIT || (page.next_cursor !== null && page.rows.length === 0)
    || (epoch !== undefined && page.epoch !== epoch) || (upper !== undefined && page.to_global_sequence !== upper)
    || !Number.isSafeInteger(page.to_global_sequence) || page.to_global_sequence < page.from_global_sequence) {
    throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
  }
  for (const row of page.rows) acceptRow(row, page.from_global_sequence, page.to_global_sequence);
}
function acceptRow(row: CompanyDailyReportRow, from: number, to: number): void {
  const complete = ["contact_new", "calendar_memo", "progress_memo"].includes(row.classification)
    && row.status === "processed_complete" && row.receipt_id !== null && row.processed_at !== null;
  if (!rowSchema.safeParse(row).success || !CLASSIFICATIONS.has(row.classification) || row.counts_as_complete !== complete
    || !Number.isInteger(row.global_sequence) || row.global_sequence <= from || row.global_sequence > to
    || !safeId(row.candidate_id) || !safeId(row.operation_id) || !safeId(row.mail_event_ref) || !safeId(row.policy_version)
    || !safeId(row.status) || (row.processed_at !== null && !INSTANT.test(row.processed_at))
    || (row.receipt_id !== null && !safeId(row.receipt_id)) || (row.error_reason !== null && !safeId(row.error_reason))) {
    throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
  }
}
function safeId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 128 && value === value.normalize("NFC") && !SECRET.test(value);
}
function documentFrom(scope: CompanyReportScope, reportDate: string, cutoffFrom: string, cutoffTo: string,
  read: ReadResult): CompanyDailyReportDocument {
  const counts = emptyCounts();
  for (const row of read.rows) {
    counts[row.classification] += 1;
    if (row.classification === "conflict") counts.human_required += 1;
    if (row.counts_as_complete) counts.completed += 1;
  }
  return {
    schema_version: 1, provider: scope.provider, workspace: scope.workspace, report_date: reportDate,
    cutoff_from: cutoffFrom, cutoff_to: cutoffTo, epoch: read.epoch, from_global_sequence: read.from_global_sequence,
    to_global_sequence: read.to_global_sequence, counts, rows: read.rows,
  };
}
function emptyCounts(): { -readonly [K in keyof CompanyDailyReportCounts]: number } {
  return { contact_new: 0, calendar_memo: 0, progress_memo: 0, human_required: 0, conflict: 0, unresolved: 0, completed: 0 };
}
function preview(document: CompanyDailyReportDocument): string {
  return `회사 내부 기록 ${String(document.counts.completed)}건`;
}
function localDate(instant: Date): { readonly date: string; readonly hour: number } {
  const local = new Date(instant.getTime() + KST_OFFSET_MS);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}
export function kstCutoff(date: string): string {
  if (!DATE.test(date)) throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID");
  return new Date(Date.UTC(year, month - 1, day, 18) - KST_OFFSET_MS).toISOString();
}
function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}
export function dueReportDate(now: Date, activationCutoff: string): string | null {
  if (!INSTANT.test(activationCutoff) || !INSTANT.test(now.toISOString())) return null;
  const local = localDate(now);
  const date = local.hour >= 18 ? local.date : previousDate(local.date);
  const cutoff = kstCutoff(date);
  if (now.getTime() < Date.parse(cutoff) || Date.parse(cutoff) < Date.parse(activationCutoff)) return null;
  return date;
}
