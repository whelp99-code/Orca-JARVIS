import type { TaskWorkLineage } from "../../src/task-work-lineage.js";

export function TaskWorkLineageView({ value }: { value?: TaskWorkLineage }) {
  return <section aria-label="업무 관계"><h4>업무 관계</h4>
    <p>{!value ? "미지정 — 재작업 여부 미상" : value.kind === "original" ? "신규 업무"
      : value.kind === "rework" ? "기존 업무 재작업" : "기술적 재시도"}</p>
    {value && value.kind !== "original" ? <dl>
      <dt>이전 요청</dt><dd>{value.prior_request_id}</dd>
      <dt>이전 요청 다이제스트</dt><dd><code>{value.prior_command_digest}</code></dd>
    </dl> : null}
  </section>;
}
