import type { MemoryCandidates as CandidatePage } from "./memory-types.js";
export function MemoryCandidates({ value }: Readonly<{ value?: CandidatePage }>) {
  return <section className="panel" aria-labelledby="memory-candidates-heading"><header className="panel-header">
    <h2 id="memory-candidates-heading">Candidates</h2></header><div className="panel-body">
    {value === undefined || value.items.length === 0 ? <p className="empty-state">No reviewable candidates</p>
      : <ul className="record-list">{value.items.map(item => <li className="record" key={item.candidate_revision}>
        <strong>{item.kind}</strong><span>{item.operation} / {item.sensitivity}</span>
        <small>{item.reason} / {item.retention.days} days</small></li>)}</ul>}
  </div></section>;
}
