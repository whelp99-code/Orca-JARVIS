import { useEffect, useState, useSyncExternalStore } from "react";
import type { MemoryClient } from "./memory-api.js";
import { MemoryCandidates } from "./memory-candidates.js";
import { MemoryDetail } from "./memory-detail.js";
import { MemoryEffects } from "./memory-effects.js";
import { MemorySearch } from "./memory-search.js";
import type { MemoryStore } from "./memory-store.js";
import type { MemoryRecord } from "./memory-types.js";
export function MemoryPage({ store, client }: Readonly<{ store: MemoryStore; client: MemoryClient }>) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [selected, setSelected] = useState<MemoryRecord>(); const [announcement, setAnnouncement] = useState("");
  useEffect(() => { void store.load(); return () => store.clearPrivate(); }, [store]);
  useEffect(() => { const clear = (): void => { setSelected(undefined); store.clearPrivate(); };
    addEventListener("pagehide", clear); return () => removeEventListener("pagehide", clear); }, [store]);
  if (snapshot.state === "loading") return <div className="page-frame route-state" aria-busy="true">
    <section role="status"><h1>Memory</h1><p>Loading private memory surface</p></section></div>;
  if (snapshot.state === "error") return <div className="page-frame route-state"><section role="alert">
    <h1>Memory</h1><p>{snapshot.message}</p></section></div>;
  return <div className="page-frame dashboard-main memory-page"><header className="memory-heading">
    <div><p className="today-kicker">USER-CONTROLLED MEMORY</p><h1>Memory</h1></div>
    <p className="freshness-badge" data-freshness={snapshot.status?.state}>{snapshot.status?.state}</p></header>
    <p className="memory-status" role="status" tabIndex={-1} aria-live="polite" aria-atomic="true">
      {announcement || (snapshot.status?.mutations_enabled ? "Current schema-4 provider" : "Memory provider unavailable")}</p>
    <div className="memory-primary"><MemorySearch result={snapshot.search} onSearch={store.search}
      onSelect={setSelected} /><MemoryDetail record={selected} client={client} onSettled={message => {
        setAnnouncement(message); setSelected(undefined); void store.load(); }} /></div>
    <section className="panel" aria-labelledby="memory-conflicts-heading"><header className="panel-header">
      <h2 id="memory-conflicts-heading">Conflicts</h2></header><div className="panel-body">
      <p className="empty-state">Unresolved conflicts appear without private side text.</p></div></section>
    <div className="memory-secondary"><MemoryCandidates value={snapshot.candidates} />
      <MemoryEffects value={snapshot.effects} /></div></div>;
}
