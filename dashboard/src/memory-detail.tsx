import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MemoryClient } from "./memory-api.js";
import { memoryCommandFailure, PENDING_APPROVAL_MESSAGE, type MemoryCommandOutcome } from "./memory-messages.js";
import type { MemoryRecord, MemoryRecordHistoryEntry } from "./memory-types.js";
import { useSurface } from "./surface.js";

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
  const phone = useSurface() === "phone";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (record === undefined) return <section className="panel" aria-labelledby="memory-detail-heading">
    <header className="panel-header"><h2 id="memory-detail-heading">내용</h2></header>
    <div className="panel-body"><p className="empty-state">기록을 고르세요.</p></div></section>;
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
    <h2 id="memory-detail-heading">내용</h2></header><div className="panel-body memory-detail" aria-busy={busy !== undefined}>
    <h3>{record.title}</h3>
    <p>{superseded ? "An approved correction superseded this record. Its previous content is no longer shown."
      : record.excerpt ?? "민감한 내용은 가려져 있습니다."}</p>
    <dl className="identity-list">
      <div><dt>출처</dt><dd>{record.citation}</dd></div>
      <div><dt>유래</dt><dd>{record.provenance.origin_label} / {record.provenance.owner_class}</dd></div>
      <div><dt>민감도</dt><dd>{record.sensitivity}</dd></div>
      <div><dt>보관</dt><dd>{record.retention.days}일, 까지 <time dateTime={record.retention.expires_at}>
        {record.retention.expires_at}</time></dd></div>
      <div><dt>신선도</dt><dd>{record.freshness}</dd></div>
      <div><dt>이력</dt><dd data-history-state={record.history_state}>{record.history_state}
        {record.superseded_by !== null && <> / superseded by {record.superseded_by}</>}</dd></div></dl>
    <MemoryHistory entries={record.history} />
    {can("correct") ? <form onSubmit={correct}><label htmlFor="memory-replacement">바꿀 내용</label>
      <textarea id="memory-replacement" autoComplete="off" value={replacement} maxLength={4096} required
        disabled={busy !== undefined} onChange={event => setReplacement(event.currentTarget.value)} />
      <button type="submit" disabled={busy !== undefined}>{busy === "correct" ? "고치는 중" : "고치기"}</button>
    </form> : null}
    {can("forget") || can("export") ? <fieldset disabled={busy !== undefined}><legend>개인정보 동작</legend>
      {can("forget") && <label><input type="checkbox" checked={acknowledged}
        onChange={event => setAcknowledged(event.currentTarget.checked)} /> 지우면 되돌릴 수 없음을 이해합니다</label>}
      <div className="memory-actions">
        {can("forget") && <button type="button" disabled={!acknowledged || busy !== undefined}
          onClick={() => { void stage("forget", () => client.forget(record.record_token, record.record_revision)); }}>
          {busy === "forget" ? "지우는 중" : "지우기"}</button>}
        {can("export") && <button type="button" disabled={busy !== undefined}
          onClick={() => { void stage("export", () => client.exportRecord(record.record_token, record.record_revision)); }}>
          {busy === "export" ? "내보내는 중" : "JSON 내보내기"}</button>}</div></fieldset>
      : <p className="empty-state">{superseded ? "바뀐 기록에는 동작이 없습니다."
        : phone ? "휴대폰에서는 바꾸지 않습니다. 컴퓨터 제어 화면에서 합니다."
        : "제공자가 최신일 때만 바꿀 수 있습니다."}</p>}
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
