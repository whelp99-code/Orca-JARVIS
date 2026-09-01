import { useState, type FormEvent } from "react";
import type { MemoryRecord, MemorySearch as MemorySearchResult } from "./memory-types.js";
export function MemorySearch({ result, onSearch, onSelect }: Readonly<{ result?: MemorySearchResult;
  onSearch: (query: string) => Promise<void>; onSelect: (record: MemoryRecord) => void }>) {
  const [query, setQuery] = useState("");
  const submit = (event: FormEvent): void => { event.preventDefault(); void onSearch(query); };
  return <section className="panel memory-search" aria-labelledby="memory-search-heading">
    <header className="panel-header"><h2 id="memory-search-heading">Search</h2></header>
    <div className="panel-body"><form onSubmit={submit}><label htmlFor="memory-query">Memory query</label>
      <div className="memory-form-row"><input id="memory-query" autoComplete="off" value={query}
        onChange={event => setQuery(event.currentTarget.value)} required maxLength={512} />
      <button type="submit">Search memory</button></div></form>
      {result === undefined ? <p className="empty-state">Search uses bounded cited records.</p>
        : result.items.length === 0 ? <p className="empty-state">No visible memory records</p>
          : <ul className="record-list">{result.items.map(item => <li className="record" key={item.record_revision}>
            <button className="memory-record-button" type="button" onClick={() => onSelect(item)}>
              <strong>{item.title}</strong><span>{item.excerpt ?? "Private record"}</span>
              <small>{item.provenance.origin_label} / {item.freshness}</small></button></li>)}</ul>}
    </div></section>;
}
