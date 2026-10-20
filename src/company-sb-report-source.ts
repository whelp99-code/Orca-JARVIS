import { z } from "zod";
import type { CompanyInternalClient } from "./company-internal-client.js";
import { CompanyDailyReportError, type CompanyDailyReportPage, type CompanyDailyReportRead,
  type CompanyDailyReportRow, type CompanyDailyReportSource } from "./company-daily-report-types.js";

const sequence = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128);
const instant = z.iso.datetime({ precision: 3 });
const rowSchema = z.object({
  candidate_id: id, classification: z.enum(["auto_internal", "human_required"]), state: id,
  source_event_id: id, policy_version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  processed_at: instant.nullable(), receipt_id: id.nullable(),
  reason_codes: z.array(z.string().regex(/^[a-z][a-z_]{0,63}$/)).max(16),
  record_kind: z.enum(["contact", "calendar", "progress"]).nullable(),
  operation_id: id, assessment_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  global_sequence: sequence,
}).strict();
const pageSchema = z.object({
  cutoff_from: instant, cutoff_to: instant, epoch: sequence, head_sequence: sequence,
  contact_new: sequence, calendar_new: sequence, progress_new: sequence, human_required: sequence,
  conflict_ambiguous: sequence, uncertain: sequence, rows: z.array(rowSchema).max(100),
  next_cursor: z.string().min(1).max(16_384).nullable(),
}).strict();
type Page = z.infer<typeof pageSchema>;
type Pin = { request: CompanyDailyReportRead; from: number; head: number; epoch: number;
  cutoff_from: string; cutoff_to: string; totals: ReturnType<typeof totals>; observed: ReturnType<typeof totals> };
function totals(page?: Page) {
  return { contact_new: page?.contact_new ?? 0, calendar_new: page?.calendar_new ?? 0, progress_new: page?.progress_new ?? 0,
    human_required: page?.human_required ?? 0, conflict_ambiguous: page?.conflict_ambiguous ?? 0, uncertain: page?.uncertain ?? 0 };
}
const CONFLICT = new Set(["conflict", "ambiguous", "mixed", "money", "contract", "tax", "outgoing",
  "invite", "customer_deletion", "prompt_injection", "timezone_unknown", "source_unknown", "fence_advanced"]);

/** Translate only the immutable SB metadata schema; pin sequence AND actual publication cutoffs. */
export class CompanySbReportSource implements CompanyDailyReportSource {
  private pin: Pin | undefined;
  private deadline = 0;
  constructor(private readonly client: Pick<CompanyInternalClient, "scope" | "report">) {}
  readPage(request: CompanyDailyReportRead): CompanyDailyReportPage {
    if (request.scope.provider !== this.client.scope.provider || request.scope.workspace !== this.client.scope.workspace) return fail();
    if (request.cursor === null) {
      this.deadline = performance.now() + 10_000;
      const latest = this.read(0, Number.MAX_SAFE_INTEGER, null);
      const head = this.cutAt(request.cutoff_to, latest);
      const from = request.from_global_sequence === 0 ? this.cutAt(request.cutoff_from, latest).head_sequence
        : request.from_global_sequence;
      if (from > head.head_sequence) return fail();
      const first = this.read(from, head.head_sequence, null);
      this.pin = { request, from, head: head.head_sequence, epoch: first.epoch,
        cutoff_from: first.cutoff_from, cutoff_to: first.cutoff_to, totals: totals(first), observed: totals() };
      return this.page(first, request);
    }
    const pin = this.pin;
    if (pin === undefined || request.scope.provider !== pin.request.scope.provider
      || request.scope.workspace !== pin.request.scope.workspace || request.report_date !== pin.request.report_date
      || request.cutoff_from !== pin.request.cutoff_from || request.cutoff_to !== pin.request.cutoff_to
      || request.from_global_sequence !== pin.request.from_global_sequence || request.to_global_sequence !== pin.head) return fail();
    return this.page(this.read(pin.from, pin.head, request.cursor), request);
  }
  private read(from: number, to: number, cursor: string | null): Page {
    if (performance.now() >= this.deadline) return fail();
    const result = pageSchema.safeParse(this.client.report({
      from_global_sequence: from, to_global_sequence: to, limit: 100, cursor,
    }));
    if (performance.now() >= this.deadline || !result.success || result.data.head_sequence < from || result.data.head_sequence > to
      || Date.parse(result.data.cutoff_from) > Date.parse(result.data.cutoff_to)) return fail();
    return result.data;
  }
  private cutAt(cutoff: string, latest: Page): Page {
    if (Date.parse(latest.cutoff_to) <= Date.parse(cutoff)) return latest;
    let low = 0; let high = latest.head_sequence;
    let selected = this.read(0, 0, null);
    if (Date.parse(selected.cutoff_to) > Date.parse(cutoff)) return fail();
    // Safe integer sequence space needs at most53 read-only probes, no effect or classifier.
    for (let probe = 0; low < high && probe < 53; probe++) {
      const middle = low + Math.ceil((high - low) / 2);
      const page = this.read(0, middle, null);
      if (page.epoch !== latest.epoch) return fail();
      if (Date.parse(page.cutoff_to) <= Date.parse(cutoff)) { low = middle; selected = page; }
      else high = middle - 1;
    }
    if (low !== high) return fail();
    return selected;
  }
  private page(page: Page, request: CompanyDailyReportRead): CompanyDailyReportPage {
    const pin = this.pin;
    if (pin === undefined || page.epoch !== pin.epoch || page.head_sequence !== pin.head
      || page.cutoff_from !== pin.cutoff_from || page.cutoff_to !== pin.cutoff_to
      || JSON.stringify(totals(page)) !== JSON.stringify(pin.totals)) return fail();
    for (const row of page.rows) {
      const projected = metadataRow(row);
      if (projected.counts_as_complete) {
        const key = row.record_kind === "contact" ? "contact_new" : row.record_kind === "calendar" ? "calendar_new" : "progress_new";
        pin.observed[key]++;
      }
      if (projected.classification === "human_required" || projected.classification === "conflict") {
        pin.observed.human_required++;
        if (projected.classification === "conflict") pin.observed.conflict_ambiguous++;
      }
      if (row.state === "uncertain") pin.observed.uncertain++;
    }
    if (page.next_cursor === null && JSON.stringify(pin.observed) !== JSON.stringify(pin.totals)) return fail();
    return { schema_version: 1, epoch: String(page.epoch), pinned_cutoff: request.cutoff_to,
      from_global_sequence: request.from_global_sequence, to_global_sequence: pin.head,
      rows: page.rows.map(row => metadataRow(row)), next_cursor: page.next_cursor };
  }
}
function metadataRow(row: z.infer<typeof rowSchema>): CompanyDailyReportRow {
  const completed = row.classification === "auto_internal" && row.state === "processed_complete"
    && row.receipt_id !== null && row.processed_at !== null && row.record_kind !== null;
  const classification = row.state === "uncertain" ? "unresolved"
    : row.classification === "human_required" ? row.reason_codes.some(reason => CONFLICT.has(reason)) ? "conflict" : "human_required"
      : !completed ? "unresolved"
        : row.record_kind === "contact" ? "contact_new" : row.record_kind === "calendar" ? "calendar_memo" : "progress_memo";
  return { candidate_id: row.candidate_id, classification, status: row.state, mail_event_ref: row.source_event_id,
    policy_version: String(row.policy_version), processed_at: row.processed_at, receipt_id: row.receipt_id,
    error_reason: row.reason_codes.length === 0 ? null : row.reason_codes.join(":"),
    operation_id: row.operation_id, global_sequence: row.global_sequence, counts_as_complete: completed };
}
function fail(): never { throw new CompanyDailyReportError("COMPANY_REPORT_PAGE_INVALID"); }
