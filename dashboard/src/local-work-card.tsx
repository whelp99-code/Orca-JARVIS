import type { LocalWorkCard } from "./local-work-card-model.js";
import type { FinanceReadAdapter } from "./finance-read-adapter.js";
import { CompanyMemoryReceipt } from "./company-memory-receipt.js";
import { MailCrmReceipt } from "./mail-crm-receipt.js";
import { CrmMemoryReceipt } from "./crm-memory-receipt.js";

export function LocalWorkCardPanel({ card, adapter }: Readonly<{ card: LocalWorkCard; adapter: FinanceReadAdapter }>) {
  const row = card.obligation;
  const identity = { "data-case-id": card.case_id, "data-source-revision": card.source_revision };
  return (
    <article className="panel local-work-card" aria-labelledby="local-work-card-title" {...identity}
      data-proof-level={card.proof_level} data-connection={card.connection}
      data-confirmation={card.confirmation} data-freshness={card.freshness} data-rt-state={card.rt.state}>
      <header className="panel-header"><h2 id="local-work-card-title">원본부터 재무 확인까지</h2></header>
      <div className="proposal-result-body">
        <p>왜: 원본과 업무·금액·승인 근거를 함께 확인해 미분류 현금을 확정 지급액으로 오인하지 않도록 합니다.</p>
        <p className="finance-read-fixture-notice">
          LOCAL_ONLY · 기록된 native membership fixture. 현재 조회나 실운영 인수가 아닙니다.
        </p>
        <p role="status">
          {card.connection === "unconnected" ? "연결 안 됨 · unconnected" : "등록·사람 확인 연결"}
          {" / "}{card.confirmation === "unconfirmed" ? "회사 연결 미확인 · unconfirmed" : "회사 연결 확인"}
          {" / "}생산자 신선도 미검증 · producer_unverified
        </p>
        <p>각 제품 영수증은 서로 다른 격리 실행입니다. 이 카드의 native 업무와 같은 회사·원본으로 합치거나 금액을 합산하지 않습니다.</p>
        {card.rt.state === "SOURCE_CHANGED" && <p role="status" className="finance-read-fixture-notice">
          원본 변경 · SOURCE_CHANGED: 기존 연결은 현재 원본의 확인 근거가 아닙니다. 현재 발주·금액 행은 제외됐습니다.
        </p>}
        <section {...identity} data-card-stage="source">
          <h3>1. 원본</h3>
          <dl className="identity-list">
            <dt>Price 원본 수</dt><dd>{row?.source_record_ids.length ?? "현재 원본 범위 없음 · null"}</dd>
            <dt>원본 문서 수</dt><dd>{row?.document_ids.length ?? "현재 원본 범위 없음 · null"}</dd>
            <dt>조회 기간</dt><dd>{card.request.period_start} — {card.request.period_end}</dd>
          </dl>
        </section>
        <section {...identity} data-card-stage="project">
          <h3>2. 프로젝트</h3>
          <dl className="identity-list">
            <dt>Native 프로젝트</dt><dd><code>{row?.project_id ?? "현재 프로젝트 확인 불가 · null"}</code></dd>
            <dt>발주 참조</dt><dd><code>{row?.order_reference ?? "현재 발주 확인 불가 · null"}</code></dd>
            <dt>CRM ↔ Price</dt><dd>{card.connection === "unconnected" ? "연결 안 됨 · 합산 없음" : "명시 등록·사람 확인"}</dd>
          </dl>
        </section>
        <section {...identity} data-card-stage="amount">
          <h3>3. 금액</h3>
          <dl className="identity-list">
            <dt>발주 / 청구 / 미청구</dt><dd>{row?.ordered ?? "null"} / {row?.invoiced ?? "null"} / {row?.unbilled ?? "null"} 원</dd>
            <dt>원본에 연결된 현금</dt><dd>{row?.net_linked_cash === undefined ? "현재 금액 확인 불가 · null" : `${row.net_linked_cash} 원`}</dd>
            <dt>미분류 현금</dt><dd data-unresolved-cash={row?.unresolved_cash_outflows ?? "null"}>
              {row === undefined ? "현재 금액 확인 불가 · null" : `${row.unresolved_cash_outflows} 원 · ${row.unresolved_cash_outflows > 0 ? "미해결" : "미분류 없음"}`}
            </dd>
            <dt>현금 잔여액</dt><dd data-residual={row?.order_cash_residual ?? "null"}>
              {row?.order_cash_residual == null ? "확정할 수 없음 · null" : row.order_cash_residual}
            </dd>
            <dt>기초 / 마감 잔액</dt><dd>{card.report.cash.opening_balance ?? "null"} / {card.report.cash.closing_balance ?? "null"}</dd>
          </dl>
        </section>
        <section {...identity} data-card-stage="approval" data-official-tax-ready={String(card.report.official_tax_ready)}>
          <h3>4. 승인·확정</h3>
          <p>기억 후보와 보관 참조는 업무 승인이나 재무 확정이 아닙니다. 지급·분개 효과 없음.</p>
          <dl className="identity-list">
            <dt>지급 확정</dt><dd data-payable-today="null">미확인 · payable_today=null / confirmed=false</dd>
            <dt>현금 범위 완전성</dt><dd>cash_coverage_complete={String(row?.cash_coverage_complete ?? null)} / bank_cutoff_verified=false</dd>
            <dt>공식 세무 준비</dt><dd>official_tax_ready=false</dd>
            <dt>회사 자료 완전성</dt><dd>company_data_complete=false</dd>
          </dl>
          <details><summary>원본 blockers와 미해결 현금 행</summary>
            <ul>{card.blockers.map(blocker => <li key={blocker.id}><code>{blocker.code} · {blocker.id}</code></li>)}</ul>
            <ul>{row?.unresolved_cash_event_ids.map(id => <li key={id}><code>{id}</code></li>)}</ul>
          </details>
        </section>
        <section {...identity} data-card-stage="receipt">
          <h3>5. Receipt</h3>
          <p>응답 body hash는 내용 무결성 근거입니다. 서명 영수증·현재 권한·신선도 증명이 아닙니다.</p>
          <details><summary>같은 case·revision과 native 조회 식별자</summary>
            <dl className="identity-list">
              <dt>내부 Case</dt><dd><code>{card.case_id}</code></dd>
              <dt>내부 J1 Report 참조</dt><dd><code>{card.report_id}</code></dd>
              <dt>응답 body revision</dt><dd><code>{card.source_revision}</code></dd>
              <dt>Native snapshot</dt><dd><code>{card.producer_snapshot}</code></dd>
              <dt>관측 시각</dt><dd><time dateTime={card.observed_at}>{card.observed_at}</time></dd>
              <dt>Fixture 회사</dt><dd><code>{card.request.company_id}</code></dd>
              <dt>Native 요청</dt><dd><code>{card.native_request.method} {card.native_request.path}?start={card.native_request.query.start}&amp;end={card.native_request.query.end}</code></dd>
              <dt>원본 참조</dt><dd><code>{row?.source_record_ids.join(" · ") ?? "현재 원본 범위 없음"}</code></dd>
              <dt>Payable coverage</dt><dd><pre>{JSON.stringify(card.report.payable_coverage, null, 2)}</pre></dd>
            </dl>
          </details>
        </section>
        <details data-card-edge="MS"><summary>MS · 메일 → 회사 기억 · 별도 후보 근거</summary>
          <CompanyMemoryReceipt evidence={adapter.company_memory_evidence} />
        </details>
        <details data-card-edge="RS"><summary>RS · CRM → 회사 기억 · 별도 보관 참조</summary>
          <CrmMemoryReceipt evidence={adapter.crm_memory_evidence} />
        </details>
        <details data-card-edge="MR"><summary>MR · 메일 → CRM · 별도 fixture 업무 매핑</summary>
          <MailCrmReceipt evidence={adapter.mail_crm_evidence} />
        </details>
        <details data-card-edge="MT"><summary>MT · 메일 첨부 → Price · 별도 업로드 근거</summary>
          <p>사람 서명·세션은 explicit fixture-only입니다. 재무 보고 회사와 다른 회사의 업로드이며 분개는 0입니다.</p>
          <dl className="identity-list">
            <dt>원본 / 첨부 revision</dt><dd><code>attachment-a / 2026-09-01T02:00:00.000Z</code></dd>
            <dt>업로드 회사</dt><dd><code>company_9e235307a9304d588cde1bb7cdd7a141</code></dd>
            <dt>원본 SHA-256</dt><dd><code>94b199be680c9aa0073e9dd0774f21771f4c57d1f167afc7861f298ddf3146b1</code></dd>
            <dt>Batch / revision</dt><dd><code>batch_5b726e180deb4a4699ee3b2d16e74099 / 2</code></dd>
            <dt>Document</dt><dd><code>document_e79dee0ac3ab4d1fa0afaac038fddf5f</code></dd>
            <dt>Producer receipt SHA-256</dt><dd><code>b8c1b8228efa74a6b72479b64472381206716085f376754ad93ea99900e60304</code></dd>
          </dl>
        </details>
        <details data-card-edge="RT" data-rt-state={card.rt.state} open>
          <summary>RT · CRM ↔ Price · {card.rt.state}</summary>
          <p>실제 로컬 Price HTTP의 상태입니다. {card.rt.identity_confirmed ? "명시 등록·사람 확인된 원본 연결입니다." : "현재 원본의 확인된 연결이 아닙니다."}
            {" "}이는 격리 fixture의 연결 식별 확인이며, 금액·지급 승인이나 실운영 연결이 아닙니다.</p>
          <dl className="identity-list">
            <dt>Native RT 상태</dt><dd><code>{card.rt.state}</code></dd>
            <dt>현재 원본</dt><dd><code>source_current={String(card.rt.source_current)}</code></dd>
            <dt>회사 / workspace 등록</dt><dd><code>{card.rt.binding === null ? "등록 없음 · null"
              : `${card.rt.binding.price_company_id} / ${card.rt.binding.crm_workspace_id}`}</code></dd>
            <dt>확인된 연결</dt><dd><code>identity_confirmed={String(card.rt.identity_confirmed)} / financial_confirmation=false</code></dd>
          </dl>
          {card.rt.links.map(link => <details key={link.id}>
            <summary>Native 원본 연결 · {link.id}</summary>
            <dl className="identity-list">
              <dt>Event / workspace</dt><dd><code>{link.event_id} / {link.workspace_id}</code></dd>
              <dt>Engagement / plan / version</dt><dd><code>{link.engagement_id} / {link.plan_id} / {link.plan_version}</code></dd>
              <dt>원본 문서 / digest</dt><dd><code>{link.source_document_id} / {link.source_digest}</code></dd>
              <dt>Native 참조</dt><dd><code>{link.native_reference_id}</code></dd>
              <dt>원본 context</dt><dd><code>{link.context_hash}</code></dd>
              <dt>Native 확인자</dt><dd><code>{link.confirmed_by ?? "미확인 · null"}</code></dd>
            </dl>
          </details>)}
          {card.rt.binding !== null && <details>
            <summary>실제 회사/workspace 등록 행 · fixture-only</summary>
            <dl className="identity-list">
              <dt>Native 등록자</dt><dd><code>{card.rt.binding.registered_by}</code></dd>
              <dt>Native 등록 시각</dt><dd><time dateTime={card.rt.binding.registered_at}>{card.rt.binding.registered_at}</time></dd>
              <dt>사람 확인 flag</dt><dd><code>confirmed_by_human={String(card.rt.binding.confirmed_by_human)}</code></dd>
            </dl>
          </details>}
        </details>
      </div>
    </article>
  );
}
