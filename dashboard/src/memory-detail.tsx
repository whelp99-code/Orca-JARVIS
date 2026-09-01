import { useState, type FormEvent } from "react";
import type { MemoryClient } from "./memory-api.js";
import type { MemoryRecord } from "./memory-types.js";
export function MemoryDetail({ record, client, onSettled }: Readonly<{ record?: MemoryRecord;
  client: MemoryClient; onSettled: (message: string) => void }>) {
  const [replacement, setReplacement] = useState(""); const [acknowledged, setAcknowledged] = useState(false);
  if (record === undefined) return <section className="panel" aria-labelledby="memory-detail-heading">
    <header className="panel-header"><h2 id="memory-detail-heading">Detail</h2></header>
    <div className="panel-body"><p className="empty-state">Select a current record.</p></div></section>;
  const correct = (event: FormEvent): void => { event.preventDefault(); void client.correct(record.record_token,
    record.record_revision, replacement).then(() => { setReplacement(""); onSettled("Pending owner approval"); }); };
  return <section className="panel" aria-labelledby="memory-detail-heading"><header className="panel-header">
    <h2 id="memory-detail-heading">Detail</h2></header><div className="panel-body memory-detail">
    <h3>{record.title}</h3><p>{record.excerpt ?? "Sensitive value remains redacted."}</p>
    <dl className="identity-list"><div><dt>Sensitivity</dt><dd>{record.sensitivity}</dd></div>
      <div><dt>Retention</dt><dd>{record.retention.days} days</dd></div>
      <div><dt>Provenance</dt><dd>{record.provenance.origin_label}</dd></div></dl>
    {record.actions.includes("correct") ? <form onSubmit={correct}><label htmlFor="memory-replacement">Replacement</label>
      <textarea id="memory-replacement" autoComplete="off" value={replacement} maxLength={4096} required
        onChange={event => setReplacement(event.currentTarget.value)} /><button type="submit">Stage correction</button></form> : null}
    <fieldset><legend>Privacy actions</legend><label><input type="checkbox" checked={acknowledged}
      onChange={event => setAcknowledged(event.currentTarget.checked)} /> I understand forgetting is irreversible</label>
      <div className="memory-actions"><button type="button" disabled={!acknowledged}
        onClick={() => void client.forget(record.record_token, record.record_revision).then(() => onSettled("Pending owner approval"))}>Stage forgetting</button>
      <button type="button" onClick={() => void client.exportRecord(record.record_token,
        record.record_revision).then(() => onSettled("Pending owner approval"))}>Stage JSON export</button></div></fieldset>
    </div></section>;
}
