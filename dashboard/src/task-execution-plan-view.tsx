import type { TaskExecutionPlan } from "../../src/task-execution-plan.js";

export function TaskExecutionPlanView({ plan }: Readonly<{ plan: TaskExecutionPlan }>) {
  return <div className="execution-plan-view">
    <dl className="identity-list">
      <div><dt>저장소</dt><dd>{plan.repository.root}</dd></div>
      <div><dt>기준 커밋</dt><dd>{plan.repository.baseline_commit}</dd></div>
      <div><dt>결과 브랜치</dt><dd>{plan.schema_version === 2 ? plan.publication.ref : "후보 전용"}</dd></div>
      <div><dt>실행 에이전트</dt><dd>{plan.provider}</dd></div>
      <div><dt>제한</dt><dd>{plan.limits.timeout_ms / 1000}초 · 출력 {plan.limits.max_output_bytes}바이트 · 네트워크 차단</dd></div>
    </dl>
    <h4>선택한 파일</h4>
    <ul className="execution-file-list">{plan.files.map(file => <li key={file.path}>
      <strong>{file.access === "read" ? "읽기" : file.before_digest === null ? "새 파일" : "수정"}</strong> <code>{file.path}</code>
    </li>)}</ul>
    <h4>완료 검사</h4>
    <ul>{plan.verification.map(check => <li key={check.id}>
      <code>{check.argv.map(arg => JSON.stringify(arg)).join(" ")}</code> · 위치 <code>{check.cwd}</code> · 종료 코드 0
    </li>)}</ul>
    <p>검증된 변경은 새 결과 브랜치에 기록됩니다. 현재 작업 파일에 적용하려면 결과를 검토해 병합하세요.</p>
  </div>;
}
