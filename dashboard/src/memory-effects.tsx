import type { MemoryEffects as EffectPage } from "./memory-types.js";
export function MemoryEffects({ value }: Readonly<{ value?: EffectPage }>) {
  return <section className="panel" aria-labelledby="memory-effects-heading"><header className="panel-header">
    <h2 id="memory-effects-heading">Effects and privacy receipts</h2></header><div className="panel-body">
    {value === undefined || value.items.length === 0 ? <p className="empty-state">No active export lifecycle</p>
      : <ul className="record-list">{value.items.map(item => <li className="record" key={item.request_id}>
        <strong>{item.operation}</strong><span>{item.state}</span><time dateTime={item.updated_at}>{item.updated_at}</time>
      </li>)}</ul>}
  </div></section>;
}
