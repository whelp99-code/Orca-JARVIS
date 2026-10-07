import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import type { DashboardClient } from "./api.js";
import { classifyDashboardError } from "./api.js";
import type { PriceFinanceConfig, PriceFinanceReceipt, PriceFinanceRequest } from "../../src/integration/price-finance-contract.js";
import "./finance-read-page.css";

type ConfigState = { readonly kind: "loading" } | { readonly kind: "ready"; readonly value: PriceFinanceConfig }
  | { readonly kind: "error"; readonly code: string };
type ReadState = { readonly kind: "idle" } | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly value: PriceFinanceReceipt } | { readonly kind: "error"; readonly code: string };
const sourceFields = z.object({
  official_tax_ready: z.boolean().optional(), company_data_complete: z.boolean().optional(),
  crm_company_binding: z.unknown().optional(),
  payable_coverage: z.object({ crm_links: z.array(z.unknown()) }).optional(),
});
const names = { owner_report: "소유자 보고", discrepancy: "불일치", settlement: "정산 조회" } as const;

export function PriceFinancePage({ client }: Readonly<{ client: DashboardClient }>) {
  const [config, setConfig] = useState<ConfigState>({ kind: "loading" });
  const [start, setStart] = useState(() => `${new Date().toISOString().slice(0, 7)}-01`);
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<PriceFinanceRequest["view"]>("owner_report");
  const [result, setResult] = useState<ReadState>({ kind: "idle" });
  const generation = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    if (client.priceFinanceConfig === undefined) {
      setConfig({ kind: "ready", value: { schema_version: 1, configured: false } });
      return undefined;
    }
    void client.priceFinanceConfig(abort.signal).then(value => {
      if (!abort.signal.aborted) setConfig({ kind: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setConfig({ kind: "error", code: classifyDashboardError(error).code });
    });
    return () => { abort.abort(); generation.current++; };
  }, [client]);
  function clear() { generation.current++; setResult({ kind: "idle" }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (config.kind !== "ready" || !config.value.configured || client.priceFinanceRead === undefined) return;
    const current = ++generation.current;
    const request = { company_id: config.value.company_id, period_start: start, period_end: end, view };
    setResult({ kind: "loading" });
    try {
      const value = await client.priceFinanceRead(request);
      if (current === generation.current) setResult({ kind: "success", value });
    } catch (error) {
      if (current === generation.current) setResult({ kind: "error", code: classifyDashboardError(error).code });
    }
  }
  if (config.kind === "loading") return <section className="page-frame dashboard-main" aria-busy="true"><h1>Price 재무 조회</h1><p role="status">읽기 연결 확인 중</p></section>;
  if (config.kind === "error") return <section className="page-frame dashboard-main"><h1>Price 재무 조회</h1><p role="alert">연결 확인 실패 · {config.code}</p></section>;
  if (!config.value.configured) return <section className="page-frame dashboard-main"><h1>재무 조회 요청 준비</h1><p>재무 조회 adapter 미연결 · 실제 조회나 fixture 권한이 활성화되지 않았습니다.</p></section>;
  return (
    <div className="page-frame dashboard-main finance-read-page" data-proof-level="operating-read">
      <header className="proposal-heading"><h1>Price 운영 재무 조회</h1>
        <p>왜: 회사 원본을 직접 읽고 미확인 금액과 공식 세무 준비 상태를 그대로 확인합니다.</p>
        <p className="finance-read-fixture-notice">전용 viewer 계정 · 읽기 전용. 조회 200은 지급·분개·세무 확정이 아닙니다.</p>
      </header>
      <form className="panel proposal-form" onSubmit={event => { void submit(event); }}>
        <header className="panel-header"><h2>조회 범위</h2></header>
        <div className="proposal-form-body">
          <p>등록된 회사: <code>{config.value.company_id}</code></p>
          <label className="form-field"><span>시작일</span><input type="date" required value={start}
            onChange={event => { setStart(event.target.value); clear(); }} /></label>
          <label className="form-field"><span>종료일</span><input type="date" required value={end} min={start}
            onChange={event => { setEnd(event.target.value); clear(); }} /></label>
          <label className="form-field"><span>조회 종류</span><select value={view} onChange={event => {
            const value = event.target.value;
            if (value === "owner_report" || value === "discrepancy" || value === "settlement") setView(value);
            clear();
          }}>{Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <p>소유자 보고는 지정 기간, 불일치·정산은 회사 전체 범위입니다.</p>
          <button type="submit" disabled={result.kind === "loading"}>Price 원본 조회</button>
          <p role={result.kind === "error" ? "alert" : "status"} aria-live="polite">
            {result.kind === "loading" ? "조회 중" : result.kind === "error" ? `조회 거부 · ${result.code}`
              : result.kind === "success" ? "원본 읽기 200 · 금융 효과 없음" : "조회하면 업무 카드와 원본 응답이 표시됩니다."}
          </p>
        </div>
      </form>
      {result.kind === "success" && <PriceReadCard receipt={result.value} />}
    </div>
  );
}

function PriceReadCard({ receipt }: Readonly<{ receipt: PriceFinanceReceipt }>) {
  const fields = sourceFields.parse(JSON.parse(receipt.response_body));
  const unbound = receipt.view === "owner_report" && fields.crm_company_binding === null
    && fields.payable_coverage?.crm_links.length === 0;
  return <article className="panel local-work-card" aria-labelledby="price-read-card-title"
    data-source-revision={receipt.source_revision} data-rt-state={unbound ? "UNBOUND" : undefined}>
    <header className="panel-header"><h2 id="price-read-card-title">업무 카드 · {names[receipt.view]}</h2></header>
    <div className="proposal-result-body">
      <p>왜: 원본의 미확인 상태를 확정 지급액이나 세무 준비 완료로 오인하지 않도록 합니다.</p>
      <dl className="identity-list">
        <dt>어디서</dt><dd>Price 운영 API</dd>
        <dt>누가</dt><dd>JARVIS 전용 읽기 계정 · viewer</dd>
        <dt>무엇을</dt><dd>{names[receipt.view]} · {receipt.view === "owner_report" ? `${receipt.request.period_start} — ${receipt.request.period_end}` : "회사 전체"}</dd>
        <dt>어떻게</dt><dd>native GET · 읽기 전용</dd>
        <dt>공식 세무 준비</dt><dd data-official-tax-ready={String(fields.official_tax_ready)}>official_tax_ready={fields.official_tax_ready === undefined ? "원본에 필드 없음" : String(fields.official_tax_ready)}</dd>
        <dt>회사 자료 완전성</dt><dd>company_data_complete={fields.company_data_complete === undefined ? "원본에 필드 없음" : String(fields.company_data_complete)}</dd>
        {unbound && <><dt>CRM ↔ Price</dt><dd>RT UNBOUND · workspace 등록 없음 · 합산 없음</dd></>}
        <dt>응답 SHA-256</dt><dd><code data-testid="price-response-sha">{receipt.source_revision}</code></dd>
        <dt>관측 시각</dt><dd><time dateTime={receipt.observed_at}>{receipt.observed_at}</time></dd>
        <dt>신선도</dt><dd>producer_unverified</dd>
      </dl>
      <p>응답 SHA는 원본 body 무결성입니다. 서명 영수증이나 생산자 신선도 검증이 아닙니다.</p>
      <details open><summary>가공하지 않은 Price 응답</summary><pre data-testid="price-response-body">{receipt.response_body}</pre></details>
    </div>
  </article>;
}
