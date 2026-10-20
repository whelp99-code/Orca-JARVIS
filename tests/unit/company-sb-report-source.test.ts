import { describe, expect, it } from "vitest";
import { CompanySbReportSource } from "../../src/company-sb-report-source.js";
import type { CompanyReportArguments } from "../../src/company-internal-client.js";
import type { CompanyDailyReportRead } from "../../src/company-daily-report-types.js";
const scope = { provider: "provider:report", workspace: "workspace:report" };
const cutoff = "2026-10-16T09:00:00.000Z";
const request: CompanyDailyReportRead = { scope, report_date: "2026-10-16",
  cutoff_from: "2026-10-16T00:00:00.000Z", cutoff_to: cutoff,
  from_global_sequence: 0, to_global_sequence: null, limit: 100, cursor: null };
function row(n: number) {
  return { candidate_id: `candidate:${n}`, classification: "auto_internal", state: "processed_complete",
    source_event_id: `mail:${n}`, policy_version: 1, processed_at: "2026-10-16T08:00:00.000Z",
    receipt_id: `receipt:${n}`, reason_codes: [] as string[], record_kind: "contact",
    operation_id: `operation:${n}`, assessment_digest: `sha256:${"a".repeat(64)}`, global_sequence: n };
}
function client(total: number, transform: (value: ReturnType<typeof row>, n: number) => object = value => value) {
  const calls: CompanyReportArguments[] = [];
  return { scope, calls, report(args: CompanyReportArguments) {
    calls.push(args);
    const head = Math.min(total, args.to_global_sequence);
    const start = args.cursor === null ? 0 : Number(args.cursor);
    const all = Array.from({ length: head }, (_, i) => row(i + 1)).filter(row => row.global_sequence > args.from_global_sequence);
    const rows = all.slice(start, start + args.limit).map(value => transform(value, value.global_sequence));
    return { cutoff_from: args.from_global_sequence === 0 ? request.cutoff_from : "2026-10-16T08:00:00.000Z",
      cutoff_to: head === 0 ? request.cutoff_from : head > 101 ? "2026-10-16T10:00:00.000Z" : "2026-10-16T08:00:00.000Z",
      epoch: 1, head_sequence: head, contact_new: all.length, calendar_new: 0, progress_new: 0,
      human_required: 0, conflict_ambiguous: 0, uncertain: 0, rows,
      next_cursor: start + args.limit < all.length ? String(start + args.limit) : null };
  } };
}
describe("actual SB report metadata adapter", () => {
  it.each(["omitted-row", "wrong-total", "changed-total"] as const)("rejects %s instead of publishing an inaccurate report", defect => {
    const wire = client(defect === "changed-total" ? 101 : 1);
    const source = new CompanySbReportSource({ scope, report(args) {
      const page = wire.report(args);
      if (defect === "omitted-row") return { ...page, rows: [] };
      if (defect === "wrong-total") return { ...page, calendar_new: 1 };
      return { ...page, ...(args.cursor === null ? {} : { contact_new: 100 }) };
    } });
    expect(() => {
      const first = source.readPage(request);
      if (first.next_cursor !== null) source.readPage({ ...request, to_global_sequence: 101, cursor: first.next_cursor });
    }).toThrow("COMPANY_REPORT_PAGE_INVALID");
  });
  it.each([0, 100, 101])("reads %s rows with the closed four-field signed query and pinned head", total => {
    const wire = client(total); const source = new CompanySbReportSource(wire);
    const first = source.readPage(request);
    const rows = [...first.rows];
    if (first.next_cursor !== null) rows.push(...source.readPage({
      ...request, to_global_sequence: first.to_global_sequence, cursor: first.next_cursor,
    }).rows);
    expect(rows).toHaveLength(total);
    expect(rows.every(row => row.counts_as_complete)).toBe(true);
    expect(wire.calls.every(args => Object.keys(args).sort().join(",") === "cursor,from_global_sequence,limit,to_global_sequence")).toBe(true);
    expect(wire.calls.every(args => args.limit === 100)).toBe(true);
  });
  it("finds the immutable sequence at18:00 rather than including later publications during catchup", () => {
    const wire = client(102); const source = new CompanySbReportSource(wire);
    const page = source.readPage(request);
    expect(page.to_global_sequence).toBe(101);
    expect(source.readPage({ ...request, to_global_sequence: 101, cursor: page.next_cursor }).rows.map(row => row.global_sequence)).toEqual([101]);
    expect(wire.calls.length).toBeLessThan(60);
  });
  it("never labels protected or unfinished entries completed", () => {
    const wire = client(3, (value, n) => n === 1 ? { ...value, classification: "human_required", reason_codes: ["money"] }
      : n === 2 ? { ...value, state: "uncertain" } : { ...value, state: "accepted", receipt_id: null });
    const page = new CompanySbReportSource({ scope, report: args => ({ ...wire.report(args),
      contact_new: 0, human_required: 1, conflict_ambiguous: 1, uncertain: 1 }) }).readPage(request);
    expect(page.rows.map(row => [row.classification, row.counts_as_complete])).toEqual([
      ["conflict", false], ["unresolved", false], ["unresolved", false],
    ]);
  });
  it("rejects extra body fields and changed epoch or publication cutoff on a cursor page", () => {
    const contaminated = client(1, value => ({ ...value, body: "PRIVATE_BODY" }));
    expect(() => new CompanySbReportSource(contaminated).readPage(request)).toThrow("COMPANY_REPORT_PAGE_INVALID");
    for (const changed of [{ epoch: 2 }, { cutoff_to: "2026-10-16T08:00:01.000Z" }]) {
      const wire = client(101);
      const source = new CompanySbReportSource({ scope, report: args => ({ ...wire.report(args), ...(args.cursor === null ? {} : changed) }) });
      const first = source.readPage(request);
      expect(() => source.readPage({ ...request, to_global_sequence: 101, cursor: first.next_cursor })).toThrow("COMPANY_REPORT_PAGE_INVALID");
    }
  });
});
