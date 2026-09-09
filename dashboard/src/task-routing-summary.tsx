import type { DashboardTaskRouting } from "../../src/dashboard/task-routing-read.js";

export function TaskRoutingSummary({ routing }: { routing: DashboardTaskRouting }) {
  return <section aria-label="작업별 실행자 선택" className="execution-template-summary">
    <h3>선택된 실행자: {routing.executor_id === "claude-code" ? "Claude Code" : routing.executor_id}</h3>
    <p>정책 {routing.policy_id} · 버전 {routing.policy_revision} · 규칙 {routing.rule_id}</p>
    <p>기록 위치 제안: {routing.proposed_record_stores.join(", ")}</p>
    <p>기록 전달 완료를 뜻하지 않습니다. 실행 환경 확인과 별도 승인이 필요합니다.</p>
    <details><summary>라우팅 식별 정보</summary><dl className="identity-list">
      <div><dt>정책 해시</dt><dd>{routing.policy_digest}</dd></div>
      <div><dt>선택 해시</dt><dd>{routing.decision_digest}</dd></div>
      <div><dt>작업 명세 해시</dt><dd>{routing.task_spec_digest}</dd></div>
    </dl></details>
  </section>;
}
