import type { MemoryCandidates as CandidatePage } from "./memory-types.js";
import type { MemoryCandidateReview } from "./memory-types.js";
import type { MemoryClient } from "./memory-api.js";
import { MemoryPanelUnloaded } from "./memory-panel-state.js";
import { useEffect, useRef, useState } from "react";
export function MemoryCandidates({ value, pending, review, reviewMessage, client, enabled, onReview, onChanged }:
  Readonly<{ value?: CandidatePage; pending: boolean; review?: MemoryCandidateReview; reviewMessage?: string;
    client: MemoryClient; enabled: boolean; onReview: (id: string) => Promise<void>; onChanged: () => void }>) {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function stage(id: string, decision?: "confirm" | "reject"): Promise<void> {
    if (inFlight.current || !enabled) return;
    if (decision !== undefined && (review?.candidate_id !== id || Date.parse(review.expires_at) <= Date.now())) {
      setMessage("검토 시간이 지났습니다. 후보를 다시 여세요."); return;
    }
    inFlight.current = true; setBusy(true);
    try {
      const result = decision === undefined ? await client.candidateDispatch(id)
        : await client.candidateDecision(id, review!.review_digest, decision);
      if (!mounted.current) return;
      setMessage(`Command ${result.request_id}: ${result.state}. Continue in Approvals.`); onChanged();
    } catch { if (mounted.current) setMessage("명령을 준비하지 못했습니다. 새로고침 후 상태를 확인하세요."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="panel" aria-labelledby="memory-candidates-heading"><header className="panel-header">
    <h2 id="memory-candidates-heading">후보</h2></header><div className="panel-body">
    <p role="status">{message || reviewMessage}</p>
    {message && <a href="/approvals">승인함 열기</a>}
    {value === undefined ? <MemoryPanelUnloaded pending={pending} />
      : value.items.length === 0 ? <p className="empty-state">확인할 후보가 없습니다</p>
      : <ul className="record-list">{value.items.map(item => <li className="record" key={item.candidate_revision}>
        <strong>{item.kind}</strong><span>{item.operation} / {item.sensitivity}</span>
        <small>{item.kind === "inference" ? "소유자 확인이 필요합니다" : item.reason} / {item.retention.days} days</small>
        {item.actions.includes("inspect") && <button type="button" disabled={busy || !enabled}
          onClick={() => { void onReview(item.candidate_id); }}>후보 보기</button>}
        {item.actions.includes("stage_dispatch") && <button type="button" disabled={busy || !enabled}
          onClick={() => { void stage(item.candidate_id); }}>저장 명령 준비</button>}
        {item.actions.length === 0 && <small>이 후보에 할 수 있는 동작이 없습니다.</small>}
        {review?.candidate_id === item.candidate_id && <div className="memory-detail">
          <strong>{review.subject}</strong><p className="memory-review-text">{review.statement}</p>
          <small>출처: {review.source_id} / {review.source_version}</small>
          <small>{review.sensitivity} / {review.retention_days} days</small>
          <p>확인은 소유자 승인만 준비합니다. 저장은 별도 명령입니다.</p>
          <div className="memory-actions"><button type="button" disabled={busy || !enabled}
            onClick={() => { void stage(item.candidate_id, "confirm"); }}>확인 준비</button>
          <button type="button" disabled={busy || !enabled}
            onClick={() => { void stage(item.candidate_id, "reject"); }}>거절 준비</button></div>
        </div>}</li>)}</ul>}
    {value?.page.has_more && <p>이 화면보다 후보가 더 있습니다.</p>}
  </div></section>;
}
