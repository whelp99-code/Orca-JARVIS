import { formatKst } from "./copy.js";
import type { CompanyDailyReportCard as Card, CompanyReportClassification } from "../../src/company-daily-report-types.js";

const LABEL: Readonly<Record<CompanyReportClassification, string>> = {
  contact_new: "연락처 신규",
  calendar_memo: "일정 메모",
  progress_memo: "진행 메모",
  human_required: "대표 승인 대기",
  conflict: "충돌·모호함",
  unresolved: "미확정",
};

export function CompanyDailyReportCard({ report, initiallyOpen = false }: Readonly<{ report: Card; initiallyOpen?: boolean }>) {
  return (
    <section className="record company-daily-report" data-company-report={report.report_id} data-report-date={report.report_date}>
      <h3 className="record-title">회사 내부 기록 자동 처리 · <time dateTime={report.report_date}>{report.report_date}</time></h3>
      <p className="record-meta">집계 마감 18:00 KST · 완료 {report.counts.completed}건</p>
      <p className="record-meta">
        {`${LABEL.contact_new} ${String(report.counts.contact_new)} / ${LABEL.calendar_memo} ${String(report.counts.calendar_memo)} / ${LABEL.progress_memo} ${String(report.counts.progress_memo)}`}
      </p>
      <p className="record-meta">
        {`${LABEL.human_required} ${String(report.counts.human_required)} / ${LABEL.conflict} ${String(report.counts.conflict)} / ${LABEL.unresolved} ${String(report.counts.unresolved)}`}
      </p>
      <p className="record-meta" data-notification-state={report.notification_state}>
        알림이 전달되지 않아도 이 목록은 유지됩니다. 자동 항목에는 대표 승인이 없습니다.
      </p>
      <details className="digest company-report-details" open={initiallyOpen}>
        <summary>회사 내부 기록 목록 보기</summary>
        <p className="record-meta"><a href={`/approvals/company-reports/${encodeURIComponent(report.report_id)}`}>이 보고서 링크</a></p>
        <ul className="record-list">
          {report.rows.length === 0 ? <li className="empty-state">이 집계 구간에는 처리 항목이 없습니다. 0건 보고도 보존됩니다.</li> : null}
          {report.rows.map(row => (
            <li className="record" key={`${String(row.global_sequence)}:${row.operation_id}`} data-classification={row.classification}>
              <p className="record-title">{row.candidate_id}</p>
              <p className="record-meta">{LABEL[row.classification]} · {row.counts_as_complete ? "처리 완료" : "완료 아님"}</p>
              <details className="digest">
                <summary>원본 근거</summary>
                <dl className="identity-list">
                  <dt>메일 event</dt><dd>{row.mail_event_ref}</dd>
                  <dt>정책 version</dt><dd>{row.policy_version}</dd>
                  <dt>처리 상태</dt><dd>{row.status}</dd>
                  <dt>최초 처리 시각</dt><dd>{row.processed_at === null ? "처리 완료 시각 없음" : <time dateTime={row.processed_at}>{formatKst(row.processed_at)}</time>}</dd>
                  <dt>원래 receipt</dt><dd id={`receipt-${report.report_id}-${row.global_sequence}`}>
                    {row.receipt_id === null ? "receipt 없음" : <a href={`#${encodeURIComponent(`receipt-${report.report_id}-${row.global_sequence}`)}`}>{row.receipt_id}</a>}
                  </dd>
                  <dt>원래 operation</dt><dd>{row.operation_id}</dd>
                  {row.error_reason !== null ? <><dt>오류 reason</dt><dd>{row.error_reason}</dd></> : null}
                </dl>
              </details>
              {row.classification === "unresolved" ? <p className="record-meta">원래 완료 확인이 끝나지 않아 완료 건수에 넣지 않습니다.</p> : null}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
