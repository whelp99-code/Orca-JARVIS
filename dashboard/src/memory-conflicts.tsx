import type { MemoryConflicts as ConflictPage } from "./memory-types.js";

export function MemoryConflicts({ value }: Readonly<{ value?: ConflictPage }>) {
  return <section className="panel" aria-labelledby="memory-conflicts-heading">
    <header className="panel-header"><h2 id="memory-conflicts-heading">Conflicts</h2></header>
    <div className="panel-body">{value === undefined || value.items.length === 0
      ? <p className="empty-state">No unresolved conflicts</p>
      : <ul className="conflict-list">{value.items.map(item => <li key={item.conflict_revision}>
        <strong>{item.subject}</strong><span className="state-label">{item.state}</span>
        <ol aria-label="Conflict sides">{item.sides.map((side, index) => <li
          key={`${item.conflict_revision}-${String(index)}`}><span>Side {String(index + 1)}</span>
          <span>{side.sensitivity}</span><small>{side.citation}</small></li>)}</ol>
      </li>)}</ul>}</div>
  </section>;
}
