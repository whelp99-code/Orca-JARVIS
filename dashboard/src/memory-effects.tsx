import type { MemoryEffects as EffectPage } from "./memory-types.js";
import type { MemoryRememberProgress } from "./memory-types.js";
import { MemoryPanelUnloaded } from "./memory-panel-state.js";

const OPERATION_LABEL: Readonly<Record<string, string>> = { correct: "Correction", forget: "Forgetting", export: "JSON export" };
const STATE_LABEL: Readonly<Record<string, string>> = { pending_approval: "소유자 승인 대기",
  applying: "승인됨, 제공자에 적용 중", completed: "확인 완료", available: "내보내기 가능" };
export function MemoryEffects({ value, pending, progress }: Readonly<{ value?: EffectPage; pending: boolean;
  progress?: MemoryRememberProgress }>) {
  return <section className="panel" aria-labelledby="memory-effects-heading"><header className="panel-header">
    <h2 id="memory-effects-heading">효과와 개인정보 영수증</h2></header><div className="panel-body">
    {progress !== undefined && progress.items.length > 0 && <ul className="record-list" aria-label="기억 저장 명령">
      {progress.items.map(item => <li className="record" key={item.request_id}>
        <strong>{item.stored ? "기억 저장됨" : `저장 명령: ${item.state}`}</strong>
        <small>{item.request_id}</small><span>제공자 처리: {item.outbox_state ?? "시작 전"}</span>
        {item.failure_code && <small>{item.failure_code}</small>}
      </li>)}</ul>}
    {progress?.has_more && <p>이 화면보다 저장 명령이 더 있습니다.</p>}
    {value === undefined ? <MemoryPanelUnloaded pending={pending} />
      : value.items.length === 0 ? <p className="empty-state">진행 중인 고치기, 지우기, 내보내기가 없습니다</p>
      : <ul className="record-list" aria-label="기억 효과">{value.items.map(item =>
        <li className="record" key={`${item.operation}:${item.request_id}`} data-effect-operation={item.operation}
          data-effect-state={item.state}>
          <strong>{OPERATION_LABEL[item.operation] ?? item.operation}</strong>
          <span>{STATE_LABEL[item.state] ?? item.state} / proof {item.proof_state}</span>
          <small>{item.request_id}</small>
          {item.failure_code !== null && <small>{item.failure_code}</small>}
          <time dateTime={item.updated_at}>{item.updated_at}</time>
        </li>)}</ul>}
    {value?.page.has_more && <p>이 화면보다 효과가 더 있습니다.</p>}
  </div></section>;
}
