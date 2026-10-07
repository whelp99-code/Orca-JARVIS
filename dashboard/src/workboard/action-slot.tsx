import { useId, useRef, useState } from "react";
import type { WorkboardCard } from "../../../src/dashboard/workboard-routes.js";
import type { ActionOperation, ActionResult, PreparedAction } from "../../../src/workboard/action-contracts.js";
import type { WorkboardActionClient } from "../authority-api.js";
import { classifyDashboardError } from "../api.js";

export function WorkboardActionSlot({ card, client, fallback }: {
  card: WorkboardCard; client?: WorkboardActionClient; fallback: string | null;
}) {
  const heading = useId();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ prepared: PreparedAction; operation: ActionOperation } | null>(null);
  const [receipt, setReceipt] = useState("");
  const [outcome, setOutcome] = useState<ActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const capability = card.action_capability;
  const pending = outcome ?? capability?.pending;
  const available = client && capability?.available && card.actions_enabled && card.freshness === "fresh"
    && card.purpose.status === "confirmed" && !card.purpose.needs_reconfirmation;
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await action(); } catch (error) { setError(classifyDashboardError(error).code); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function submit() {
    if (!client || !dialog) return;
    // Parse before marking as submitted; a malformed receipt has never left this browser.
    const proof: unknown = dialog.prepared.requiresReceipt ? JSON.parse(receipt) : undefined;
    setSubmitted(true);
    const result = await client.submit(dialog.prepared.token, dialog.operation, proof);
    setOutcome(result); setDialog(null);
  }
  return <div aria-busy={busy}>
    {pending ? <>
      <p role="status">{pending.status === "uncertain" ? "전달 결과 확인 중" : `원천 확인: ${pending.receipt?.sourceState ?? "불명"}`}</p>
      {pending.status === "uncertain" && client ? <button type="button" disabled={busy} onClick={() => void run(async () => {
        setOutcome(await client.reconcile(pending.intentId));
      })}>원천 결과 다시 확인</button> : null}
      {pending.receipt ? <details><summary>처리 근거 보기</summary><pre>{JSON.stringify(pending.receipt, null, 2)}</pre></details> : null}
    </> : available ? capability.effects.map(effect => <button key={effect.operation} type="button" data-operation={effect.operation}
      disabled={busy || dialog !== null} onClick={() => void run(async () => {
        const prepared = await client.prepare(card.work_id);
        setSubmitted(false); setReceipt(""); setDialog({ prepared, operation: effect.operation });
      })}>{effect.label}</button>) : fallback === null ? null : <span className="wb-source-chip">
      {fallback} · 원천에서 처리 · {capability?.reason || (card.freshness !== "fresh" ? "최신 원천 상태 확인이 필요합니다" : "검증된 구조화 처리 프로토콜이 연결되지 않았습니다")}
      {" · "}{capability?.location || `${card.source.app} / ${card.source.scope} / 근거 보기의 세션`}
    </span>}
    {error ? <p role="alert">{submitted ? "전달 결과 확인 중 · " : "요청을 다시 확인하세요 · "}{error}</p> : null}
    {dialog ? <dialog open aria-labelledby={heading}>
      <h4 id={heading}>{dialog.prepared.request.effects.find(e => e.operation === dialog.operation)?.label}</h4>
      <p>{dialog.prepared.request.target} · {dialog.prepared.request.scope}</p>
      <p>{dialog.prepared.request.effects.find(e => e.operation === dialog.operation)?.resumesExecution
        ? "이 승인을 보내면 원천에서 즉시 실행을 재개합니다." : "표시한 요청과 범위에만 이 결정을 보냅니다."}</p>
      <pre>{JSON.stringify(dialog.prepared.request.payload, null, 2)}</pre>
      {dialog.prepared.requiresReceipt ? <label>서명된 Control Plane 영수증<textarea value={receipt} disabled={submitted}
        onChange={event => setReceipt(event.target.value)} /></label> : null}
      <button type="button" data-action="confirm" disabled={busy} onClick={() => void run(submit)}>{submitted ? "같은 요청 결과 확인" : "확인 후 보내기"}</button>
      <button type="button" disabled={busy || submitted} onClick={() => setDialog(null)}>취소</button>
    </dialog> : null}
  </div>;
}
