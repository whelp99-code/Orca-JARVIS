import type { TaskTemplateBinding } from "../../src/task-templates.js";
import { TEMPLATE_LABELS } from "./task-template-contract.js";

export function TaskTemplateSummary({ template }: { template: TaskTemplateBinding }) {
  return <section aria-label="템플릿 범위" className="execution-template-summary">
    <h3>{TEMPLATE_LABELS[template.template_id] ?? template.template_id} · v{template.revision}</h3>
    {template.template_id !== "code-fix" ? <p>완료는 보고서 구조와 원문 인용 검사를 통과했다는 뜻입니다.
      진단·권고의 정확성은 검토가 필요하며, 자동으로 조치하지 않습니다.</p> : null}
    <ul>{template.files.map(file => <li key={file.path}>
      <strong>{file.access === "read" ? "읽기 전용" : "결과 쓰기"}</strong>: <code>{file.path}</code>
    </li>)}</ul>
    <h4>필수 완료 검사</h4>
    <ul>{template.verification.map(check => <li key={check.id}>{template.template_id !== "code-fix" && check.id === "template-report-v1"
      ? "보고서 필수 항목과 원본 인용 확인" : `${check.argv.join(" ")} (위치: ${check.cwd})`}</li>)}</ul>
    <details><summary>템플릿 식별 정보</summary><p>{template.template_id} · {template.definition_digest}</p></details>
  </section>;
}
