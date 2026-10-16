import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { CompanyDailyReportCycle, kstCutoff } from "../../src/company-daily-report-cycle.js";
import { CompanyDailyReportStore } from "../../src/company-daily-report-store.js";
import { CompanyDailyReportError, type CompanyDailyReportPage, type CompanyDailyReportRead,
  type CompanyDailyReportRow, type CompanyDailyReportSource } from "../../src/company-daily-report-types.js";
import { NotificationDeliveryStore } from "../../src/notification-delivery-store.js";
import { tempDb } from "../helpers.js";

const SCOPE = { provider: "sb-company", workspace: "workspace-1" } as const;
const ACTIVATION = "2026-10-16T09:00:00.000Z";
const BEFORE = new Date("2026-10-16T08:59:59.999Z");
const AT = new Date("2026-10-16T09:00:00.000Z");

async function db(): Promise<AuthorityDb> {
  const authority = new AuthorityDb(tempDb());
  await authority.migrate();
  return authority;
}
function row(sequence: number, classification: CompanyDailyReportRow["classification"] = "contact_new"): CompanyDailyReportRow {
  return {
    candidate_id: `candidate-${String(sequence)}`, classification, status: "processed_complete",
    mail_event_ref: `mail-event-${String(sequence)}`, policy_version: "policy-1",
    processed_at: "2026-10-16T01:00:00.000Z", receipt_id: `receipt-${String(sequence)}`, error_reason: null,
    operation_id: `operation-${String(sequence)}`, global_sequence: sequence,
    counts_as_complete: ["contact_new", "calendar_memo", "progress_memo"].includes(classification),
  };
}
function source(count: number, mutate?: (page: number) => void): CompanyDailyReportSource & { readonly calls: number } {
  let calls = 0;
  return { get calls() { return calls; }, readPage(request): CompanyDailyReportPage {
    calls += 1;
    mutate?.(calls);
    const start = request.cursor === null ? 0 : Number(request.cursor);
    const rows = Array.from({ length: count }, (_, index) => row(index + 1)).slice(start, start + request.limit);
    return page(request, count, rows, start + request.limit < count ? String(start + request.limit) : null);
  } };
}
function page(request: CompanyDailyReportRead, upper: number, rows: readonly CompanyDailyReportRow[], cursor: string | null): CompanyDailyReportPage {
  return { schema_version: 1, epoch: "epoch-1", pinned_cutoff: request.cutoff_to, from_global_sequence: request.from_global_sequence,
    to_global_sequence: upper, rows, next_cursor: cursor };
}
function cycle(authority: AuthorityDb, reportSource: CompanyDailyReportSource, activation = ACTIVATION): CompanyDailyReportCycle {
  return new CompanyDailyReportCycle(authority, { enabled: true, scope: SCOPE, activation_cutoff: activation, source: reportSource });
}
function count(authority: AuthorityDb): number {
  return Number((authority.db.prepare("SELECT COUNT(*) AS n FROM company_daily_reports").get() as { n: number }).n);
}

describe("company daily report", () => {
  it("publishes nothing before 18:00 KST and one report at the cutoff", async () => {
    expect(kstCutoff("2026-10-16")).toBe("2026-10-16T09:00:00.000Z");
    const authority = await db();
    const reportSource = source(0);
    const publisher = cycle(authority, reportSource);
    expect(publisher.publishDue(BEFORE).status).toBe("idle");
    expect(count(authority)).toBe(0);
    const published = publisher.publishDue(AT);
    expect(published.status).toBe("published");
    expect(count(authority)).toBe(1);
    expect(publisher.publishDue(AT).status).toBe("published");
    expect(reportSource.calls).toBe(1);
    expect(count(authority)).toBe(1);
    expect(authority.db.prepare("SELECT COUNT(*) AS n FROM company_report_notifications").get()).toEqual({ n: 1 });
    expect(authority.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 1 });
  });

  it("keeps one report when a nested tick overlaps the first read", async () => {
    const authority = await db();
    let nested: string | undefined;
    const publisher = cycle(authority, { readPage(request) {
      nested = publisher.publishDue(AT).status;
      return page(request, 0, [], null);
    } });
    expect(publisher.publishDue(AT).status).toBe("published");
    expect(nested).toBe("idle");
    expect(count(authority)).toBe(1);
  });

  it("catches up only the latest missed date", async () => {
    const authority = await db();
    const publisher = cycle(authority, source(0), "2026-10-14T09:00:00.000Z");
    expect(publisher.publishDue(BEFORE).status).toBe("published");
    expect(authority.db.prepare("SELECT report_date FROM company_daily_reports").all()).toEqual([{ report_date: "2026-10-15" }]);
    expect(publisher.publishDue(AT).status).toBe("published");
    expect(authority.db.prepare("SELECT report_date FROM company_daily_reports ORDER BY report_date").all())
      .toEqual([{ report_date: "2026-10-15" }, { report_date: "2026-10-16" }]);
  });

  it("publishes an empty list and keeps protected rows out of the completed count", async () => {
    const authority = await db();
    const rows = [row(1, "human_required"), row(2, "conflict"), row(3, "unresolved")];
    const publisher = cycle(authority, { readPage: request => page(request, 3, rows, null) });
    publisher.publishDue(AT);
    const stored = JSON.parse(String((authority.db.prepare("SELECT report_json FROM company_daily_reports").get() as { report_json: string }).report_json)) as {
      counts: { completed: number; unresolved: number; human_required: number; conflict: number }; rows: readonly { candidate_id: string }[];
    };
    expect(stored.counts.completed).toBe(0);
    expect(stored.counts.unresolved).toBe(1);
    expect(stored.counts.human_required).toBe(2);
    expect(stored.counts.conflict).toBe(1);
    expect(JSON.stringify(stored)).not.toMatch(/@|password|secret/);
    expect(stored.rows.map(item => item.candidate_id)).toEqual(["candidate-1", "candidate-2", "candidate-3"]);
  });

  it.each([0, 100, 101])("pages %s rows once without duplicate keys", async (total) => {
    const authority = await db();
    const reportSource = source(total);
    cycle(authority, reportSource).publishDue(AT);
    const stored = JSON.parse(String((authority.db.prepare("SELECT report_json FROM company_daily_reports").get() as { report_json: string }).report_json)) as {
      rows: readonly { global_sequence: number }[];
    };
    expect(stored.rows).toHaveLength(total);
    expect(new Set(stored.rows.map(item => item.global_sequence)).size).toBe(total);
    expect(reportSource.calls).toBe(total === 101 ? 2 : 1);
  });

  it("does not commit when a later cursor page changes epoch", async () => {
    const authority = await db();
    const publisher = cycle(authority, { readPage(request) {
      const first = request.cursor === null;
      return { ...page(request, 101, [row(first ? 1 : 101)], first ? "100" : null), epoch: first ? "epoch-1" : "epoch-2",
        rows: Array.from({ length: first ? 100 : 1 }, (_, index) => row(index + (first ? 1 : 101))) };
    } });
    expect(() => publisher.publishDue(AT)).toThrow(CompanyDailyReportError);
    expect(count(authority)).toBe(0);
  });

  it("rejects a body value and leaves the original digest on conflict", async () => {
    const authority = await db();
    expect(() => cycle(authority, { readPage: request => page(request, 1, [{ ...row(1), mail_event_ref: "owner@example.com" }], null) }).publishDue(AT))
      .toThrow(CompanyDailyReportError);
    expect(count(authority)).toBe(0);
    const first = source(1);
    const publisher = cycle(authority, first);
    publisher.publishDue(AT);
    const digest = (authority.db.prepare("SELECT report_digest FROM company_daily_reports").get() as { report_digest: string }).report_digest;
    const stored = JSON.parse(String((authority.db.prepare("SELECT report_json FROM company_daily_reports").get() as { report_json: string }).report_json));
    const store = new CompanyDailyReportStore(authority);
    expect(() => store.insert({ document: { ...stored, rows: [{ ...row(1), classification: "calendar_memo" }] },
      preview: "회사 내부 기록", publishedAt: AT.toISOString() })).toThrow("COMPANY_REPORT_DIGEST_CONFLICT");
    expect(authority.db.prepare("SELECT report_digest FROM company_daily_reports").get()).toEqual({ report_digest: digest });
    expect(count(authority)).toBe(1);
  });

  it("leaves the report visible when an old client cannot claim and a capable client reports unsupported", async () => {
    const authority = await db();
    const reportSource = source(1);
    const published = cycle(authority, reportSource).publishDue(AT);
    expect(published.status).toBe("published");
    const store = new NotificationDeliveryStore({ authority, resourceIsCurrent: () => true });
    expect(store.claimEffect(AT.toISOString(), "old-session", false).value).toBeNull();
    expect(authority.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "queued" });
    const claimed = store.claimEffect(AT.toISOString(), "new-session", true).value;
    expect(claimed?.payload.alert_class).toBe("company_daily_report");
    expect(claimed?.payload.deep_link.startsWith("jarvis://open/company-report?id=")).toBe(true);
    store.settleEffect({ deliveryId: claimed?.delivery_id ?? "", input: { schema_version: 1, outcome: "failed", failure_code: "NOTIFICATIONS_UNSUPPORTED" },
      now: AT.toISOString(), sessionId: "new-session" });
    expect(authority.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "failed" });
    expect(authority.db.prepare("SELECT state FROM company_report_notifications").get()).toEqual({ state: "unsupported" });
    expect(authority.db.prepare("SELECT state FROM notification_deliveries").get()).not.toEqual({ state: "delivered" });
    expect(count(authority)).toBe(1);
    expect(reportSource.calls).toBe(1);
  });
});
