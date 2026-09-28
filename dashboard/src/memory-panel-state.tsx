/** The explicit non-data states of a Memory panel: never render "none" for data that was not read. */
export function MemoryPanelUnloaded({ pending }: Readonly<{ pending: boolean }>) {
  if (pending) return <p className="empty-state" role="status" aria-busy="true" data-panel-state="loading">Loading</p>;
  return <p className="empty-state" data-panel-state="unloaded">Not loaded. Use Refresh memory to read this panel.</p>;
}
