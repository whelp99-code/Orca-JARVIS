import { useState } from "react";
import type { CompanyDailyReportCard as Card, CompanyReportClassification } from "../../src/company-daily-report-types.js";

const LABEL: Readonly<Record<CompanyReportClassification, string>> = {
  contact_new: "연락처 신규",
  calendar_memo: "일정 메모",
  progress_memo: "진행 메모",
  human_required: "대표 승인 대기",
  conflict: "충돌·모호함",
  unresolved: "미확정",
};

export function CompanyDailyReportCard({ report }: Readonly<{ report: Card }>) {
  const [open, setOpen] = useState(false);
  return (
    <section className="record" data-company-report={report.report_id} data-report-date={report.report_date}>
      <button type="button" className="record-title" onClick={() => { setOpen(value => !value); }}>
        {`회사 내부 기록 자동 처리 | ${report.report_date} | cutoff 18:00 KST`}
      </button>
      <p className="record-meta">
        {`${LABEL.contact_new} ${String(report.counts.contact_new)} / ${LABEL.calendar_memo} ${String(report.counts.calendar_memo)} / ${LABEL.progress_memo} ${String(report.counts.progress_memo)}`}
      </p>
      <p className="record-meta">
        {`${LABEL.human_required} ${String(report.counts.human_required)} / ${LABEL.conflict} ${String(report.counts.conflict)} / ${LABEL.unresolved} ${String(report.counts.unresolved)}`}
      </p>
      <p className="record-meta" data-notification-state={report.notification_state}>
        알림이 전달되지 않아도 이 목록은 유지됩니다. 자동 항목에는 대표 승인이 없습니다.
      </p>
      {open ? (
        <ul className="record-list">
          {report.rows.map(row => (
            <li className="record" key={`${String(row.global_sequence)}:${row.operation_id}`} data-classification={row.classification}>
              <p className="record-title">{row.candidate_id}</p>
              <p className="record-meta">{`${LABEL[row.classification]} · ${row.status} · ${row.policy_version}`}</p>
              <p className="record-meta">{`${row.mail_event_ref} · ${row.receipt_id ?? "receipt 없음"} · ${row.processed_at ?? "시각 없음"}`}</p>
              {row.error_reason !== null ? <p className="record-meta">{row.error_reason}</p> : null}
              {row.classification === "unresolved" ? <p className="record-meta">{`미확정 ${row.operation_id}는 완료 건수에 넣지 않습니다.`}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
