import type { MemoryEffects as EffectPage } from "./memory-types.js";
import type { MemoryRememberProgress } from "./memory-types.js";
import { MemoryPanelUnloaded } from "./memory-panel-state.js";

const OPERATION_LABEL: Readonly<Record<string, string>> = { correct: "Correction", forget: "Forgetting", export: "JSON export" };
const STATE_LABEL: Readonly<Record<string, string>> = { pending_approval: "Pending owner approval",
  applying: "Approved, applying at provider", completed: "Verified complete", available: "Export available" };
export function MemoryEffects({ value, pending, progress }: Readonly<{ value?: EffectPage; pending: boolean;
  progress?: MemoryRememberProgress }>) {
  return <section className="panel" aria-labelledby="memory-effects-heading"><header className="panel-header">
    <h2 id="memory-effects-heading">Effects and privacy receipts</h2></header><div className="panel-body">
    {progress !== undefined && progress.items.length > 0 && <ul className="record-list" aria-label="Memory storage commands">
      {progress.items.map(item => <li className="record" key={item.request_id}>
        <strong>{item.stored ? "Memory stored" : `Storage command: ${item.state}`}</strong>
        <small>{item.request_id}</small><span>Provider processing: {item.outbox_state ?? "not started"}</span>
        {item.failure_code && <small>{item.failure_code}</small>}
      </li>)}</ul>}
    {progress?.has_more && <p>More storage commands exist than this view can show.</p>}
    {value === undefined ? <MemoryPanelUnloaded pending={pending} />
      : value.items.length === 0 ? <p className="empty-state">No active correction, forgetting, or export lifecycle</p>
      : <ul className="record-list" aria-label="Memory effect lifecycles">{value.items.map(item =>
        <li className="record" key={`${item.operation}:${item.request_id}`} data-effect-operation={item.operation}
          data-effect-state={item.state}>
          <strong>{OPERATION_LABEL[item.operation] ?? item.operation}</strong>
          <span>{STATE_LABEL[item.state] ?? item.state} / proof {item.proof_state}</span>
          <small>{item.request_id}</small>
          {item.failure_code !== null && <small>{item.failure_code}</small>}
          <time dateTime={item.updated_at}>{item.updated_at}</time>
        </li>)}</ul>}
    {value?.page.has_more && <p>More lifecycles exist than this view can show.</p>}
  </div></section>;
}
