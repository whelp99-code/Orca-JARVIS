import type { CrmMemoryReceiptEvidence } from "./crm-memory-admitted-fixture.js";

export function CrmMemoryReceipt({ evidence }: Readonly<{ evidence: CrmMemoryReceiptEvidence }>) {
  return (
    <section className="panel finance-read-ms-receipt" aria-labelledby="crm-memory-receipt-title"
      data-proof-level={evidence.proof_level} data-archive-approved={String(evidence.archive_approved)}>
      <header className="panel-header"><h2 id="crm-memory-receipt-title">업무 참조 → 회사 기억 전달 근거</h2></header>
      <div className="proposal-result-body">
        <p>왜: 업무 참조의 원본과 전달 영수증을 남겨 기억 후보의 근거를 확인합니다.</p>
        <p className="finance-read-fixture-notice">
          Root의 독립 RS 격리 실행 기록입니다. 생산자의 이전 fixture ID와 구분되며 새 전달이나 현재 연결이 아닙니다.
          보관 참조는 승인되지 않은 원본 투영이고, 기억 후보·업무 승인·재무 진실은 서로 다릅니다.
          운영 outbox와 실제 회사·개인 기억이 연결된 상태를 뜻하지 않습니다.
        </p>
        <dl className="identity-list">
          <dt>증거 수준</dt><dd><code>{evidence.proof_level}</code></dd>
          <dt>수용 수준</dt><dd><code>{evidence.authority_level}</code></dd>
          <dt>기억 상태</dt><dd><code>{evidence.state}</code></dd>
          <dt>전달 Ack / Version</dt><dd><code>{evidence.ack} / {evidence.ack_version}</code></dd>
          <dt>보관 참조 권한</dt><dd><code>{evidence.archive_authority}</code></dd>
          <dt>원본 승인 여부</dt><dd><code>{String(evidence.archive_approved)}</code></dd>
        </dl>
        <details><summary>RS 원본과 수용 영수증</summary>
          <dl className="identity-list">
            <dt>Parser</dt><dd><code>{evidence.parser_version}</code></dd>
            <dt>원본 bytes SHA-256</dt><dd><code>{evidence.source_bytes_sha256}</code></dd>
            <dt>Request digest</dt><dd><code>{evidence.request_digest}</code></dd>
            <dt>Root Receive receipt</dt><dd><code>{evidence.receipt_id}</code></dd>
            <dt>Locator 승인 표기</dt><dd><code>{evidence.locator_approved} · string</code></dd>
            <dt>Root 독립 검증</dt><dd><code>{evidence.root_monitor}</code></dd>
            <dt>수용 기록 SHA-256</dt><dd><code>{evidence.admission_sha256}</code></dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
