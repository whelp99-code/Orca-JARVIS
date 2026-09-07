import type { MemoryCandidates as CandidatePage } from "./memory-types.js";
import type { MemoryCandidateReview } from "./memory-types.js";
import type { MemoryClient } from "./memory-api.js";
import { useEffect, useRef, useState } from "react";
export function MemoryCandidates({ value, review, reviewMessage, client, enabled, onReview, onChanged }:
  Readonly<{ value?: CandidatePage; review?: MemoryCandidateReview; reviewMessage?: string;
    client: MemoryClient; enabled: boolean; onReview: (id: string) => Promise<void>; onChanged: () => void }>) {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function stage(id: string, decision?: "confirm" | "reject"): Promise<void> {
    if (pending.current || !enabled) return;
    if (decision !== undefined && (review?.candidate_id !== id || Date.parse(review.expires_at) <= Date.now())) {
      setMessage("Review expired. Open the candidate again."); return;
    }
    pending.current = true; setBusy(true);
    try {
      const result = decision === undefined ? await client.candidateDispatch(id)
        : await client.candidateDecision(id, review!.review_digest, decision);
      if (!mounted.current) return;
      setMessage(`Command ${result.request_id}: ${result.state}. Continue in Approvals.`); onChanged();
    } catch { if (mounted.current) setMessage("Command could not be prepared. Refresh the candidate and check its state."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="panel" aria-labelledby="memory-candidates-heading"><header className="panel-header">
    <h2 id="memory-candidates-heading">Candidates</h2></header><div className="panel-body">
    <p role="status">{message || reviewMessage}</p>
    {message && <a href="/approvals">Open Approvals</a>}
    {value === undefined || value.items.length === 0 ? <p className="empty-state">No reviewable candidates</p>
      : <ul className="record-list">{value.items.map(item => <li className="record" key={item.candidate_revision}>
        <strong>{item.kind}</strong><span>{item.operation} / {item.sensitivity}</span>
        <small>{item.kind === "inference" ? "Owner confirmation required" : item.reason} / {item.retention.days} days</small>
        {item.actions.includes("inspect") && <button type="button" disabled={busy || !enabled}
          onClick={() => { void onReview(item.candidate_id); }}>Review candidate</button>}
        {item.actions.includes("stage_dispatch") && <button type="button" disabled={busy || !enabled}
          onClick={() => { void stage(item.candidate_id); }}>Prepare storage command</button>}
        {item.actions.length === 0 && <small>No action is available for this candidate. Check storage commands for progress.</small>}
        {review?.candidate_id === item.candidate_id && <div className="memory-detail">
          <strong>{review.subject}</strong><p className="memory-review-text">{review.statement}</p>
          <small>Source: {review.source_id} / {review.source_version}</small>
          <small>{review.sensitivity} / {review.retention_days} days</small>
          <p>Confirmation prepares a decision for owner approval. Saving requires a separate storage command.</p>
          <div className="memory-actions"><button type="button" disabled={busy || !enabled}
            onClick={() => { void stage(item.candidate_id, "confirm"); }}>Prepare confirmation</button>
          <button type="button" disabled={busy || !enabled}
            onClick={() => { void stage(item.candidate_id, "reject"); }}>Prepare rejection</button></div>
        </div>}</li>)}</ul>}
    {value?.page.has_more && <p>More candidates exist than this view can show.</p>}
  </div></section>;
}
