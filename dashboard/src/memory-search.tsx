import { useState, type FormEvent } from "react";
import { memoryResourceState, type MemoryRecord, type MemoryResourceState,
  type MemorySearch as MemorySearchResult } from "./memory-types.js";

const STATE_COPY: Record<Exclude<MemoryResourceState, "ready" | "no_data">, string> = {
  stale: "The provider reported stale evidence. Results may be out of date.",
  offline: "Memory provider offline. Results are unavailable until it reconnects.",
  unavailable: "기억 제공자를 사용할 수 없습니다.",
  incompatible: "Memory provider incompatible. Results cannot be read right now.",
};
export function MemorySearch({ result, onSearch, onSelect }: Readonly<{ result?: MemorySearchResult;
  onSearch: (query: string) => Promise<void>; onSelect: (record: MemoryRecord) => void }>) {
  const [query, setQuery] = useState(""); const [searching, setSearching] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (searching) return;
    setSearching(true); void onSearch(query).finally(() => { setSearching(false); });
  };
  return <section className="panel memory-search" aria-labelledby="memory-search-heading">
    <header className="panel-header"><h2 id="memory-search-heading">Search</h2></header>
    <div className="panel-body"><form onSubmit={submit}><label htmlFor="memory-query">기억 검색</label>
      <div className="memory-form-row"><input id="memory-query" autoComplete="off" value={query}
        onChange={event => setQuery(event.currentTarget.value)} required maxLength={512} />
      <button type="submit" disabled={searching} aria-busy={searching}>{searching ? "검색 중" : "기억 검색"}</button></div></form>
      {result === undefined ? <p className="empty-state">검색은 출처가 있는 기록만 봅니다.</p> : <MemoryResults result={result} onSelect={onSelect} />}
    </div></section>;
}

function MemoryResults({ result, onSelect }: Readonly<{ result: MemorySearchResult; onSelect: (record: MemoryRecord) => void }>) {
  const state = memoryResourceState(result.state);
  const withheld = result.omissions.includes("privacy_filtered");
  switch (state) {
    case "offline": case "unavailable": case "incompatible":
      return <p className="memory-result-state" role="status" data-result-state={state}>{STATE_COPY[state]}</p>;
    case "ready": case "stale": case "no_data": {
      if (result.items.length === 0) return <p className="empty-state" data-result-state={state}>
        {withheld ? "Matching records are withheld by owner privacy decisions." : "보이는 기억이 없습니다"}</p>;
      return <>
        {state === "stale" && <p className="memory-result-state" role="status" data-result-state={state}>{STATE_COPY.stale}</p>}
        {result.truncated && <p className="memory-result-state">More records match than this bounded view shows.</p>}
        <ul className="record-list">{result.items.map(item => <li className="record" key={item.record_revision}>
          <button className="memory-record-button" type="button" onClick={() => onSelect(item)}
            data-history-state={item.history_state}>
            <strong>{item.title}</strong>{item.excerpt !== item.title && <span>{item.excerpt ?? (item.history_state === "superseded"
              ? "Superseded by an approved correction" : "Private record")}</span>}
            <small>{item.citation} / {item.provenance.origin_label} / {item.freshness}</small></button></li>)}</ul></>;
    }
    default: return assertNever(state);
  }
}
function assertNever(value: never): never { throw new TypeError(`unexpected memory state: ${String(value)}`); }
