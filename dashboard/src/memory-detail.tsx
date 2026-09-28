import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MemoryClient } from "./memory-api.js";
import { memoryCommandFailure, PENDING_APPROVAL_MESSAGE, type MemoryCommandOutcome } from "./memory-messages.js";
import type { MemoryRecord, MemoryRecordHistoryEntry } from "./memory-types.js";

export type MemoryDetailOutcome = MemoryCommandOutcome;
type Action = "correct" | "forget" | "export";
const OPERATION_LABEL: Record<MemoryRecordHistoryEntry["operation"], string> = {
  correct: "Correction", forget: "Forgetting", export: "JSON export" };
const HISTORY_STATE_LABEL: Readonly<Record<string, string>> = {
  staged: "pending owner approval", approved: "approved, applying at provider", claimed: "applying at provider",
  reconciling: "reconciling with provider", completed: "verified complete", receipt_rejected: "rejected by owner",
  expired: "expired unapproved", failed: "failed", uncertain: "outcome uncertain", superseded: "attempt superseded",
  suppressed: "approved and effective" };

export function MemoryDetail({ record, client, enabled, onOutcome }: Readonly<{ record?: MemoryRecord;
  client: MemoryClient; enabled: boolean; onOutcome: (outcome: MemoryDetailOutcome) => void }>) {
  const [replacement, setReplacement] = useState(""); const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<Action>();
  const pending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (record === undefined) return <section className="panel" aria-labelledby="memory-detail-heading">
    <header className="panel-header"><h2 id="memory-detail-heading">Detail</h2></header>
    <div className="panel-body"><p className="empty-state">Select a current record.</p></div></section>;
  const superseded = record.history_state === "superseded";
  const can = (action: Action): boolean => enabled && record.actions.includes(action);
  async function stage(action: Action, command: () => Promise<unknown>): Promise<void> {
    if (pending.current || !can(action)) return;
    pending.current = true; setBusy(action);
    try {
      await command();
      if (!mounted.current) return;
      setReplacement(""); setAcknowledged(false);
      onOutcome({ kind: "staged", message: PENDING_APPROVAL_MESSAGE });
    } catch (error: unknown) {
      if (mounted.current) onOutcome(memoryCommandFailure(error));
    } finally { pending.current = false; if (mounted.current) setBusy(undefined); }
  }
  const correct = (event: FormEvent): void => { event.preventDefault();
    void stage("correct", () => client.correct(record.record_token, record.record_revision, replacement)); };
  return <section className="panel" aria-labelledby="memory-detail-heading"><header className="panel-header">
    <h2 id="memory-detail-heading">Detail</h2></header><div className="panel-body memory-detail" aria-busy={busy !== undefined}>
    <h3>{record.title}</h3>
    <p>{superseded ? "An approved correction superseded this record. Its previous content is no longer shown."
      : record.excerpt ?? "Sensitive value remains redacted."}</p>
    <dl className="identity-list">
      <div><dt>Citation</dt><dd>{record.citation}</dd></div>
      <div><dt>Provenance</dt><dd>{record.provenance.origin_label} / {record.provenance.owner_class}</dd></div>
      <div><dt>Sensitivity</dt><dd>{record.sensitivity}</dd></div>
      <div><dt>Retention</dt><dd>{record.retention.days} days, until <time dateTime={record.retention.expires_at}>
        {record.retention.expires_at}</time></dd></div>
      <div><dt>Freshness</dt><dd>{record.freshness}</dd></div>
      <div><dt>History</dt><dd data-history-state={record.history_state}>{record.history_state}
        {record.superseded_by !== null && <> / superseded by {record.superseded_by}</>}</dd></div></dl>
    <MemoryHistory entries={record.history} />
    {can("correct") ? <form onSubmit={correct}><label htmlFor="memory-replacement">Replacement</label>
      <textarea id="memory-replacement" autoComplete="off" value={replacement} maxLength={4096} required
        disabled={busy !== undefined} onChange={event => setReplacement(event.currentTarget.value)} />
      <button type="submit" disabled={busy !== undefined}>{busy === "correct" ? "Staging correction" : "Stage correction"}</button>
    </form> : null}
    {can("forget") || can("export") ? <fieldset disabled={busy !== undefined}><legend>Privacy actions</legend>
      {can("forget") && <label><input type="checkbox" checked={acknowledged}
        onChange={event => setAcknowledged(event.currentTarget.checked)} /> I understand forgetting is irreversible</label>}
      <div className="memory-actions">
        {can("forget") && <button type="button" disabled={!acknowledged || busy !== undefined}
          onClick={() => { void stage("forget", () => client.forget(record.record_token, record.record_revision)); }}>
          {busy === "forget" ? "Staging forgetting" : "Stage forgetting"}</button>}
        {can("export") && <button type="button" disabled={busy !== undefined}
          onClick={() => { void stage("export", () => client.exportRecord(record.record_token, record.record_revision)); }}>
          {busy === "export" ? "Staging JSON export" : "Stage JSON export"}</button>}</div></fieldset>
      : <p className="empty-state">{superseded ? "No actions apply to a superseded record."
        : "Changes are unavailable until the provider is current."}</p>}
    </div></section>;
}

function MemoryHistory({ entries }: Readonly<{ entries: readonly MemoryRecordHistoryEntry[] }>) {
  if (entries.length === 0) return <p className="memory-history-empty">No owner commands recorded for this record.</p>;
  return <ol className="record-list memory-history" aria-label="Record history">{entries.map(entry =>
    <li className="record" key={`${entry.request_id}:${entry.state}`}>
      <strong>{OPERATION_LABEL[entry.operation]}</strong><span>{HISTORY_STATE_LABEL[entry.state] ?? entry.state}</span>
      <small>{entry.request_id}</small>
      {entry.receipt_id !== null && <small>Receipt {entry.receipt_id}</small>}
      <time dateTime={entry.at}>{entry.at}</time></li>)}</ol>;
}
