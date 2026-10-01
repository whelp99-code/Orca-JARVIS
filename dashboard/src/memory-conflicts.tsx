import { MemoryPanelUnloaded } from "./memory-panel-state.js";
import { memoryResourceState, type MemoryConflicts as ConflictPage } from "./memory-types.js";

const STATE_COPY: Readonly<Record<string, string>> = {
  offline: "Memory provider offline. Conflicts cannot be read until it reconnects.",
  unavailable: "기억 제공자를 사용할 수 없습니다. 충돌은 지금 읽을 수 없습니다.",
  incompatible: "Memory provider incompatible. Conflicts cannot be read right now.",
};
export function MemoryConflicts({ value, pending }: Readonly<{ value?: ConflictPage; pending: boolean }>) {
  return <section className="panel" aria-labelledby="memory-conflicts-heading">
    <header className="panel-header"><h2 id="memory-conflicts-heading">충돌</h2></header>
    <div className="panel-body"><ConflictBody value={value} pending={pending} /></div>
  </section>;
}
function ConflictBody({ value, pending }: Readonly<{ value?: ConflictPage; pending: boolean }>) {
  if (value === undefined) return <MemoryPanelUnloaded pending={pending} />;
  const copy = STATE_COPY[memoryResourceState(value.state)];
  if (copy !== undefined) return <p className="memory-result-state" role="status"
    data-result-state={memoryResourceState(value.state)}>{copy}</p>;
  if (value.items.length === 0) return <p className="empty-state">풀리지 않은 충돌이 없습니다</p>;
  return <ul className="conflict-list">{value.items.map(item => <li key={item.conflict_revision}>
    <strong>{item.subject}</strong><span className="state-label">{item.state}</span>
    <ol aria-label="Conflict sides">{item.sides.map((side, index) => <li
      key={`${item.conflict_revision}-${String(index)}`}><span>Side {String(index + 1)}</span>
      <span>{side.sensitivity}</span><small>{side.citation}</small></li>)}</ol>
  </li>)}</ul>;
}
