import type { MemoryEffects as EffectPage } from "./memory-types.js";
import type { MemoryRememberProgress } from "./memory-types.js";
export function MemoryEffects({ value, progress }: Readonly<{ value?: EffectPage; progress?: MemoryRememberProgress }>) {
  return <section className="panel" aria-labelledby="memory-effects-heading"><header className="panel-header">
    <h2 id="memory-effects-heading">Effects and privacy receipts</h2></header><div className="panel-body">
    {progress !== undefined && progress.items.length > 0 && <ul className="record-list" aria-label="Memory storage commands">
      {progress.items.map(item => <li className="record" key={item.request_id}>
        <strong>{item.stored ? "Memory stored" : `Storage command: ${item.state}`}</strong>
        <small>{item.request_id}</small><span>Provider processing: {item.outbox_state ?? "not started"}</span>
        {item.failure_code && <small>{item.failure_code}</small>}
      </li>)}</ul>}
    {progress?.has_more && <p>More storage commands exist than this view can show.</p>}
    {value === undefined || value.items.length === 0 ? <p className="empty-state">No active export lifecycle</p>
      : <ul className="record-list">{value.items.map(item => <li className="record" key={item.request_id}>
        <strong>{item.operation}</strong><span>{item.state}</span><time dateTime={item.updated_at}>{item.updated_at}</time>
      </li>)}</ul>}
  </div></section>;
}
