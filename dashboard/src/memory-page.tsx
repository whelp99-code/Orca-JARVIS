import { useEffect, useState, useSyncExternalStore } from "react";
import { copy, stateLabel } from "./copy.js";
import type { MemoryClient } from "./memory-api.js";
import { MemoryCandidates } from "./memory-candidates.js";
import { MemoryConflicts } from "./memory-conflicts.js";
import { MemoryDetail, type MemoryDetailOutcome } from "./memory-detail.js";
import { MemoryEffects } from "./memory-effects.js";
import { MemorySearch } from "./memory-search.js";
import type { MemoryStore } from "./memory-store.js";
import { memoryResourceState, type MemoryResourceState, type MemorySnapshot } from "./memory-types.js";
import { useSurface } from "./surface.js";

/** What the badge names: the provider state of the latest read, or `expired` when the status token lapsed. */
export type MemoryProviderBadge = MemoryResourceState | "expired";
export function providerState(snapshot: MemorySnapshot): MemoryProviderBadge {
  const status = snapshot.status;
  if (status === undefined) return "unavailable";
  if (status.state === "stale") return "expired";
  const reported = snapshot.search?.state ?? snapshot.conflicts?.state;
  if (reported !== undefined) {
    const state = memoryResourceState(reported);
    if (state === "offline" || state === "unavailable" || state === "incompatible" || state === "stale") return state;
  }
  if (status.state !== "ready") return memoryResourceState(status.state);
  return status.mutations_enabled ? "ready" : "incompatible";
}
const PROVIDER_COPY: Record<MemoryProviderBadge, string> = {
  ready: "기억 제공자가 준비되었습니다",
  expired: "기억 상태가 만료되었습니다. 검색하거나 기억 새로고침을 누르세요.",
  stale: "기억 제공자 기록이 오래되었습니다. 지금은 바꿀 수 없습니다.",
  no_data: "기억 제공자가 준비되었습니다",
  offline: "기억 제공자가 끊겼습니다. 다시 연결되기 전에는 검색할 수 없습니다.",
  unavailable: "기억 제공자를 사용할 수 없습니다.",
  incompatible: "기억은 읽기만 됩니다. 고치기, 지우기, 내보내기는 지금은 없습니다.",
};
export function MemoryPage({ store, client }: Readonly<{ store: MemoryStore; client: MemoryClient }>) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Selection follows the record revision, so refreshed results (new single-use tokens) keep it.
  const [selectedRevision, setSelectedRevision] = useState<string>();
  /** An outcome speaks for one search generation; when that generation ends the region reverts to provider copy. */
  const [announced, setAnnounced] = useState<{ revision?: number; message: string }>({ message: "" });
  const [refreshing, setRefreshing] = useState(false);
  // The phone gateway proxies status, conflicts and search only; every memory change is a Linux owner command.
  const phone = useSurface() === "phone";
  const selected = snapshot.state === "ready"
    ? snapshot.search?.items.find(item => item.record_revision === selectedRevision) : undefined;
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  useEffect(() => {
    const clear = (): void => { setSelectedRevision(undefined); store.clearPrivate(); };
    const restore = (event: PageTransitionEvent): void => { if (event.persisted) { clear(); void store.load(); } };
    window.addEventListener("pagehide", clear); window.addEventListener("pageshow", restore);
    return () => { window.removeEventListener("pagehide", clear); window.removeEventListener("pageshow", restore); };
  }, [store]);
  if (snapshot.state === "loading") return <div className="page-frame route-state" aria-busy="true">
    <section role="status"><h1>{copy.pages.memory}</h1><p>기억을 불러오는 중</p></section></div>;
  if (snapshot.state === "error") return <div className="page-frame route-state"><section role="alert">
    <h1>{copy.pages.memory}</h1><p>{snapshot.message}</p></section></div>;
  const provider = providerState(snapshot);
  const mutable = !phone && provider === "ready" && snapshot.status?.mutations_enabled === true;
  const refresh = (): void => {
    if (refreshing) return;
    setRefreshing(true); setAnnounced({ message: "" });
    void store.load().finally(() => { setRefreshing(false); });
  };
  const settle = (outcome: MemoryDetailOutcome): void => {
    if (store.getSnapshot().search_revision !== snapshot.search_revision) return;
    if (outcome.kind === "stale") {
      // The rejection is proof these rows are out of date, so drop them and re-read rather than keep
      // listing a record the provider may already have forgotten. The reason is re-announced against
      // the generation the clear opens, otherwise it would be discarded with the rows it explains.
      setSelectedRevision(undefined);
      store.clearPrivate();
      setAnnounced({ revision: store.getSnapshot().search_revision, message: outcome.message });
      void store.load();
      return;
    }
    setAnnounced({ revision: snapshot.search_revision, message: outcome.message });
    if (outcome.kind === "staged") { setSelectedRevision(undefined); void store.load(); }
  };
  return <div className="page-frame dashboard-main memory-page"><header className="memory-heading">
    <div><p className="today-kicker">내가 통제하는 기억</p><h1>{copy.pages.memory}</h1></div>
    <div className="memory-heading-controls"><p className="freshness-badge" data-freshness={provider}>{stateLabel(provider)}</p>
      <button type="button" onClick={refresh} disabled={refreshing} aria-busy={refreshing}>
        {refreshing ? "기억을 다시 불러오는 중" : "기억 새로고침"}</button></div></header>
    <p className="memory-status" role="status" tabIndex={-1} aria-live="polite" aria-atomic="true">
      {snapshot.message || (announced.revision === snapshot.search_revision ? announced.message : "")
        || PROVIDER_COPY[provider]}</p>
    <div className="memory-primary"><MemorySearch key={snapshot.clear_revision ?? 0}
      result={snapshot.search} onSearch={store.search}
      onSelect={item => setSelectedRevision(item.record_revision)} /><MemoryDetail
      key={`${snapshot.search_revision ?? 0}:${selected?.record_revision ?? "empty"}`}
      record={selected} client={client} enabled={mutable} onOutcome={settle} /></div>
    <MemoryConflicts value={snapshot.conflicts} pending={snapshot.reloading === true} />
    {phone ? null : <div className="memory-secondary"><MemoryCandidates pending={snapshot.reloading === true}
      key={`${snapshot.status?.privacy_epoch ?? 0}:${snapshot.candidates === undefined ? "cleared" : "loaded"}`}
      value={snapshot.candidates} review={snapshot.review}
      reviewMessage={snapshot.reviewMessage} client={client} enabled={mutable}
      onReview={store.review} onChanged={() => {
        if (store.getSnapshot().candidates === snapshot.candidates) void store.load(); }} />
      <MemoryEffects value={snapshot.effects} pending={snapshot.reloading === true} progress={snapshot.progress} /></div>}</div>;
}
