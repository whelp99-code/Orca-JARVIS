import { useState, type FormEvent } from "react";
import { JarvisError } from "../../src/jarvis-error.js";
import type { FinanceReadEnvelope, PreparedFinanceRead } from "../../src/integration/finance-read-gateway.js";
import type { FinanceReadAdapter } from "./finance-read-adapter.js";
import { CompanyMemoryReceipt } from "./company-memory-receipt.js";
import { MailCrmReceipt } from "./mail-crm-receipt.js";
import { CrmMemoryReceipt } from "./crm-memory-receipt.js";
import { LocalWorkCardPanel } from "./local-work-card.js";
import "./finance-read-page.css";

type Outcome = { kind: "idle" } | { kind: "prepared"; value: PreparedFinanceRead }
  | { kind: "refused"; code: string };

const REFUSALS: Readonly<Record<string, string>> = {
  CORE5_FINANCE_COMPANY_SCOPE_DENIED: "등록된 fixture 회사와 요청 회사가 다릅니다.",
  CORE5_FINANCE_INPUT_INVALID: "v2 계약과 회사·참조·조회 범위를 확인하세요.",
  CORE5_FINANCE_SOURCE_STALE: "요청 원본 revision이 등록된 fixture와 다릅니다.",
  CORE5_CALLER_EXPIRED: "격리 fixture 호출 권한이 만료되었습니다.",
  CORE5_CALLER_UNVERIFIED: "등록된 fixture 호출자와 요청 호출자가 다릅니다.",
  CORE5_FINANCE_VERSION_UNSUPPORTED: "등록된 대상이 finance.read v2를 지원하지 않습니다.",
};

export function FinanceReadPage({ adapter }: Readonly<{ adapter: FinanceReadAdapter }>) {
  const [company, setCompany] = useState(adapter.company_id);
  const [reference, setReference] = useState("case:fp5-fixture");
  const [referenceKind, setReferenceKind] = useState<"case_id" | "report_id">("case_id");
  const [view, setView] = useState<FinanceReadEnvelope["payload"]["view"]>("reconciliation");
  const [version, setVersion] = useState(2);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  function clear() { setOutcome({ kind: "idle" }); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const payload = {
        company_id: company, source_revision: adapter.source_revision, view,
        ...(referenceKind === "case_id" ? { case_id: reference } : { report_id: reference }),
      };
      setOutcome({ kind: "prepared", value: adapter.prepare(adapter.request(payload, version)) });
    } catch (error) {
      if (!(error instanceof JarvisError)) throw error;
      setOutcome({ kind: "refused", code: error.code });
    }
  }
  const prepared = outcome.kind === "prepared" ? outcome.value : undefined;
  return (
    <div className="page-frame dashboard-main finance-read-page" data-proof-level={adapter.proof_level}>
      <header className="proposal-heading">
        <h1>{adapter.work_card === undefined ? "재무 조회 요청 준비" : "업무 원본·금액 확인"}</h1>
        <p>왜: 회사와 원본 범위를 먼저 확인해 잘못된 대상을 조회하지 않도록 합니다.</p>
        <p className="finance-read-fixture-notice">
          격리 fixture · 실제 회사 데이터, 제공자 호출, 승인 소비가 없습니다.
          {adapter.work_card === undefined ? "여기서 준비된 요청은 재무 결과나 J2 통합 인수가 아닙니다."
            : "기록된 native 결과와 제품별 격리 근거를 함께 봅니다. 미연결 업무는 통합 인수가 아닙니다."}
        </p>
      </header>
      {adapter.work_card === undefined ? null : <LocalWorkCardPanel card={adapter.work_card} adapter={adapter} />}
      <details open={adapter.work_card === undefined}>
        <summary>J1 기존 격리 요청 준비 · native 조회와 별도</summary>
      <div className="proposal-layout">
        <form className="panel proposal-form" onSubmit={submit}>
          <header className="panel-header"><h2>조회 범위</h2></header>
          <div className="proposal-form-body">
            <label className="form-field"><span>회사 ID</span>
              <input required maxLength={256} value={company} onChange={event => { setCompany(event.target.value); clear(); }} />
            </label>
            <label className="form-field"><span>참조 종류</span>
              <select value={referenceKind} onChange={event => {
                setReferenceKind(event.target.value === "report_id" ? "report_id" : "case_id"); clear();
              }}><option value="case_id">Case</option><option value="report_id">Report</option></select>
            </label>
            <label className="form-field"><span>Case / Report ID</span>
              <input required maxLength={256} value={reference} onChange={event => { setReference(event.target.value); clear(); }} />
            </label>
            <label className="form-field"><span>조회 view</span>
              <select value={view} onChange={event => {
                const value = event.target.value;
                if (value === "reconciliation" || value === "owner_report" || value === "discrepancy") setView(value);
                clear();
              }}>
                <option value="reconciliation">대사 · reconciliation</option>
                <option value="owner_report">소유자 보고 · owner_report</option>
                <option value="discrepancy">불일치 · discrepancy</option>
              </select>
            </label>
            <label className="form-field"><span>계약 version</span>
              <select value={version} onChange={event => { setVersion(Number(event.target.value)); clear(); }}>
                <option value={2}>v2 · finance.read</option><option value={1}>v1 · 거부 확인</option>
              </select>
            </label>
            <button type="submit">격리 요청 검사</button>
          </div>
        </form>
        <section className="panel proposal-result" aria-labelledby="finance-read-result-title">
          <header className="panel-header"><h2 id="finance-read-result-title">준비 결과</h2></header>
          <div className="proposal-result-body">
            <p role="status" aria-live="polite" aria-atomic="true" data-outcome={outcome.kind}>
              {outcome.kind === "idle" ? "요청을 검사하면 로컬 계약 결과가 표시됩니다."
                : outcome.kind === "prepared" ? "격리 요청 준비됨 · 실제 조회나 승인 결과가 아닙니다."
                : REFUSALS[outcome.code] ?? "격리 요청이 계약 경계에서 거부되었습니다."}
            </p>
            <dl className="identity-list">
              <dt>대상</dt><dd><code>{adapter.target_id}</code></dd>
              <dt>등록된 회사</dt><dd><code>{adapter.company_id}</code></dd>
              <dt>원본 revision</dt><dd><code>{adapter.source_revision}</code></dd>
            </dl>
            {prepared !== undefined && (
              <div data-testid="finance-read-prepared">
                <dl className="identity-list">
                  <dt>요청 회사</dt><dd><code>{prepared.payload.company_id}</code></dd>
                  <dt>참조</dt><dd><code>{prepared.payload.case_id ?? prepared.payload.report_id}</code></dd>
                  <dt>View</dt><dd><code>{prepared.payload.view}</code></dd>
                  <dt>Version</dt><dd>{prepared.schema_version}</dd>
                </dl>
                <details><summary>격리 실행 식별자</summary>
                  <dl className="identity-list">
                    <dt>Operation</dt><dd><code>{prepared.operation_id}</code></dd>
                    <dt>Attempt</dt><dd><code>{prepared.attempt_id}</code></dd>
                    <dt>Fence</dt><dd><code>{prepared.lease_fence}</code></dd>
                  </dl>
                </details>
              </div>
            )}
          </div>
        </section>
      </div>
      </details>
      {adapter.work_card === undefined && <>
        <CompanyMemoryReceipt evidence={adapter.company_memory_evidence} />
        <MailCrmReceipt evidence={adapter.mail_crm_evidence} />
        <CrmMemoryReceipt evidence={adapter.crm_memory_evidence} />
      </>}
    </div>
  );
}
