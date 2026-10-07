import type { MailCrmReceiptEvidence } from "./mail-crm-admitted-fixture.js";

export function MailCrmReceipt({ evidence }: Readonly<{ evidence: MailCrmReceiptEvidence }>) {
  return (
    <section className="panel finance-read-ms-receipt" aria-labelledby="mail-crm-receipt-title"
      data-proof-level={evidence.proof_level} data-mapping-authority={evidence.mapping_authority}>
      <header className="panel-header"><h2 id="mail-crm-receipt-title">메일 → 업무 연결 근거</h2></header>
      <div className="proposal-result-body">
        <p>왜: 메일 원본이 어느 업무로 연결됐는지 요청과 감사 기록을 함께 확인합니다.</p>
        <p className="finance-read-fixture-notice">
          Root가 수용한 격리 MR 계약의 Mail 생산자 기록입니다. Root의 새 실행 ID나 현재 연결이 아닙니다.
          수신은 머신 fixture, 업무 매핑은 별도 human fixture로 검증됐으며 실제 사용자 권한은 없습니다.
          회사 기억 MS 원본과 별도 기록이며, 보관 참조는 승인이나 재무 진실이 아닙니다.
        </p>
        <dl className="identity-list">
          <dt>증거 수준</dt><dd><code>{evidence.proof_level}</code></dd>
          <dt>메일 원본</dt><dd><code>{evidence.source_locator}</code></dd>
          <dt>수신 명령 / Version</dt><dd><code>{evidence.receive_command} / {evidence.receive_version}</code></dd>
          <dt>매핑 명령 / Version</dt><dd><code>{evidence.mapping_command} / {evidence.mapping_version}</code></dd>
          <dt>매핑 권한 수준</dt><dd><code>{evidence.mapping_authority}</code></dd>
        </dl>
        <details><summary>MR 원본과 요청·감사 식별자</summary>
          <dl className="identity-list">
            <dt>원본 digest</dt><dd><code>{evidence.source_digest}</code></dd>
            <dt>수신 Idempotency</dt><dd><code>{evidence.receive_idempotency_key}</code></dd>
            <dt>수신 Audit hash</dt><dd><code>{evidence.receive_audit_hash}</code></dd>
            <dt>매핑 Idempotency</dt><dd><code>{evidence.mapping_idempotency_key}</code></dd>
            <dt>매핑 Audit hash</dt><dd><code>{evidence.mapping_audit_hash}</code></dd>
            <dt>매핑 State hash</dt><dd><code>{evidence.mapping_state_hash}</code></dd>
            <dt>Mail 생산자 실행</dt><dd><code>{evidence.producer_monitor}</code></dd>
            <dt>Root 독립 계약 검증</dt><dd><code>{evidence.root_monitor}</code></dd>
            <dt>수용 기록 SHA-256</dt><dd><code>{evidence.admission_sha256}</code></dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
