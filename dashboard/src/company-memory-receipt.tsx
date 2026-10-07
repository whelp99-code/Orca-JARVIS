import type { CompanyMemoryReceiptEvidence } from "./company-memory-admitted-fixture.js";

export function CompanyMemoryReceipt({ evidence }: Readonly<{ evidence: CompanyMemoryReceiptEvidence }>) {
  return (
    <section className="panel finance-read-ms-receipt" aria-labelledby="company-memory-receipt-title"
      data-proof-level={evidence.proof_level} data-memory-state={evidence.state}>
      <header className="panel-header"><h2 id="company-memory-receipt-title">회사 기억 전달 근거</h2></header>
      <div className="proposal-result-body">
        <p>왜: 메일 원본과 전달 영수증을 함께 남겨 기억 후보의 출처를 확인합니다.</p>
        <p className="finance-read-fixture-notice">
          Root가 수용한 격리 MS 실행의 기록입니다. 현재 연결 상태나 새 조회가 아니며,
          회사 기억 후보는 업무 승인·개인 기억·재무 결과가 아닙니다.
          위 재무 fixture와는 별도 회사 범위입니다.
        </p>
        <dl className="identity-list">
          <dt>증거 수준</dt><dd><code>{evidence.proof_level}</code></dd>
          <dt>기억 상태</dt><dd><code>{evidence.state}</code></dd>
          <dt>전달 Ack / Version</dt><dd><code>{evidence.ack} / {evidence.ack_version}</code></dd>
          <dt>MS workspace</dt><dd><code>{evidence.workspace_id}</code></dd>
          <dt>후보 ID</dt><dd><code>{evidence.candidate_id}</code></dd>
        </dl>
        <details><summary>원본과 수용 영수증</summary>
          <dl className="identity-list">
            <dt>Source locator</dt><dd><code>{evidence.source_locator}</code></dd>
            <dt>Source event</dt><dd><code>{evidence.source_event_id}</code></dd>
            <dt>Locator kind / Graph ID</dt><dd><code>{evidence.locator.kind} / {evidence.locator.graph_id}</code></dd>
            <dt>Parser</dt><dd><code>{evidence.parser_version}</code></dd>
            <dt>Content digest</dt><dd><code>{evidence.content_digest}</code></dd>
            <dt>Request digest</dt><dd><code>{evidence.request_digest}</code></dd>
            <dt>수용된 Receive receipt</dt><dd><code>{evidence.admitted_receipt_id}</code></dd>
            <dt>Root 실행 근거</dt><dd><code>{evidence.monitor}</code></dd>
            <dt>수용 기록 SHA-256</dt><dd><code>{evidence.admission_sha256}</code></dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
