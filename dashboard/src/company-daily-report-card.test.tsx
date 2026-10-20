import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyDailyReportCard as Card } from "../../src/company-daily-report-types.js";
import { CompanyDailyReportCard } from "./company-daily-report-card.js";
import { OwnerInboxPanel } from "./owner-inbox-panel.js";
import { SurfaceContext } from "./surface.js";

const report: Card = {
  report_id: "company-report:v1:abc", report_date: "2026-10-16",
  cutoff_from: "2026-10-16T09:00:00.000Z", cutoff_to: "2026-10-16T09:00:00.000Z",
  counts: { contact_new: 1, calendar_memo: 0, progress_memo: 0, human_required: 1, conflict: 0, unresolved: 1, completed: 1 },
  notification_state: "pending",
  rows: [{
    candidate_id: "candidate-1", classification: "human_required", status: "waiting", mail_event_ref: "mail-event-1",
    policy_version: "policy-1", processed_at: null, receipt_id: "receipt-1", error_reason: null,
    operation_id: "operation-1", global_sequence: 1, counts_as_complete: false,
  }],
};
afterEach(() => { vi.unstubAllGlobals(); });

describe("company daily report card", () => {
  it("does not advertise unsupported report navigation on the phone", () => {
    render(<SurfaceContext.Provider value="phone"><CompanyDailyReportCard report={report} initiallyOpen /></SurfaceContext.Provider>);
    expect(screen.queryByRole("link", { name: "이 보고서 링크" })).not.toBeInTheDocument();
    expect(screen.getByText("candidate-1")).toBeInTheDocument();
  });

  it("links a bounded summary to its exact local detail without pretending its rows are empty", () => {
    const summary = { report_id: report.report_id, report_date: report.report_date, cutoff_from: report.cutoff_from,
      cutoff_to: report.cutoff_to, counts: report.counts, notification_state: report.notification_state };
    render(<CompanyDailyReportCard report={summary} />);
    expect(screen.getByRole("link", { name: "이 보고서 링크" })).toHaveAttribute("href",
      `/approvals/company-reports/${encodeURIComponent(report.report_id)}`);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
  it("shows metadata and no approval action", async () => {
    const user = userEvent.setup();
    render(<CompanyDailyReportCard report={report} />);
    expect(screen.getByText(/2026-10-16/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
    await user.click(screen.getByText("회사 내부 기록 목록 보기"));
    expect(screen.getByText("candidate-1")).toBeInTheDocument();
    await user.click(screen.getByText("원본 근거"));
    expect(screen.getByText(/receipt-1/)).toBeInTheDocument();
    const original = screen.getByRole("link", { name: "receipt-1" });
    const fragment = original.getAttribute("href")?.slice(1) ?? "";
    expect(document.getElementById(decodeURIComponent(fragment))).toContainElement(original);
  });

  it("keeps the human passkey candidate beside the read-only report", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/v1/session"
      ? { csrf_token: "csrf-token-csrf-token-csrf-token-1" }
      : { schema_version: 1, passkey_enrolled: true, company_reports: [report], items: [{
        request_id: "human-1", action: "company.candidate.transition", summary: "사람 승인", command_digest: "sha256:" + "ab".repeat(32),
        expires_at: "2026-10-16T10:00:00.000Z",
      }] }), { status: 200 })));
    render(<OwnerInboxPanel />);
    expect(await screen.findByText("사람 승인")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /회사 내부 기록 자동 처리/ })).toBeInTheDocument();
  });
});
