import { useEffect, useState } from "react";
import { MAIL_CANDIDATE_RECENT_LIMIT, mailCandidatesSummarySchema,
  type MailCandidatesReadAdapter, type MailCandidatesSummary } from "./mail-candidates-model.js";
import {
  describeFixtureFreshness,
  describeNativeObservationFreshness,
  elapsedDays,
  formatReadableDate,
  formatReadableTimestamp,
} from "./finance-readable-format.js";
import "./finance-read-page.css";

type LoadState =
  | { readonly adapter: MailCandidatesReadAdapter | undefined; readonly kind: "loading" }
  | { readonly adapter: MailCandidatesReadAdapter; readonly kind: "read"; readonly value: MailCandidatesSummary }
  | { readonly adapter: MailCandidatesReadAdapter; readonly kind: "error" };

export function MailCandidatesCard({ adapter }: Readonly<{ adapter?: MailCandidatesReadAdapter }>) {
  const [state, setState] = useState<LoadState>({ adapter, kind: "loading" });
  useEffect(() => {
    if (adapter === undefined) return undefined;
    const abort = new AbortController();
    setState({ adapter, kind: "loading" });
    void adapter.read(abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const parsed = mailCandidatesSummarySchema.safeParse(value);
      if (!parsed.success || (adapter.workspace_id !== undefined && [parsed.data.crm, parsed.data.sb].some(source =>
        source.state === "read" && source.workspace_id !== adapter.workspace_id))) {
        setState({ adapter, kind: "error" });
      } else setState({ adapter, kind: "read", value: parsed.data });
    }, () => { if (!abort.signal.aborted) setState({ adapter, kind: "error" }); });
    return () => { abort.abort(); };
  }, [adapter]);
  const current = state.adapter === adapter ? state : undefined;
  const value = current?.kind === "read" ? current.value : undefined;
  const crm = value?.crm;
  const sb = value?.sb;
  const loading = adapter !== undefined && (current === undefined || current.kind === "loading");
  const refused = [crm, sb].some(source => source?.state === "unconnected" && source.reason === "refused");
  return <section className="page-frame dashboard-main finance-read-page" aria-busy={loading}>
    <article className="panel local-work-card" aria-labelledby="mail-candidates-title"
      data-proof-level={value?.proof_level ?? "unconnected"} data-authority="none"
      data-load-state={adapter === undefined ? "unconnected" : current?.kind ?? "loading"}>
      <header className="panel-header"><h2 id="mail-candidates-title">메일에서 온 후보</h2></header>
      <div className="proposal-result-body">
        <p>왜: 메일에서 생긴 CRM 업무 후보와 SB 회사기억 후보를 확인하되 확정된 업무·기억으로 오인하지 않도록 합니다.</p>
        {value?.proof_level === "isolated-fixture" && <p className="finance-read-fixture-notice">LOCAL_ONLY · 격리 fixture · 운영 후보함은 연결 안 됨</p>}
        {value?.proof_level === "native-read" && (crm?.state === "read" || sb?.state === "read")
          && <p>운영 원본 조회 · 후보 수신은 업무 승인·확정이 아님</p>}
        <p role={current?.kind === "error" || refused ? "alert" : "status"}>
          {loading ? "후보 목록 읽기 확인 중" : current?.kind === "error"
            ? "연결 안 됨 · 후보 목록 확인 실패" : refused
              ? "연결 안 됨 · 일부 원본 조회 거부" : "읽기 전용 · 후보 확정·수정 권한 없음"}
        </p>
        <dl className="identity-list">
          <dt>CRM 후보함</dt><dd data-candidate-source="crm" data-source-state={crm?.state ?? "unconnected"}
            data-candidate-count={crm?.state === "read" ? crm.candidate_count : undefined}>
            {crm?.state === "read" ? `${crm.candidate_count}건 · 메일 후보` : "연결 안 됨"}
          </dd>
          <dt>SB 회사기억 후보</dt><dd data-candidate-source="sb" data-source-state={sb?.state ?? "unconnected"}
            data-candidate-count={sb?.state === "read" ? sb.candidate_count : undefined}>
            {sb?.state === "read" ? `${sb.candidate_count}건 · 메일 후보` : "연결 안 됨"}
          </dd>
          {value !== undefined && <><dt>{value.proof_level === "isolated-fixture" ? "Fixture 관측 시각" : "조회 시각"}</dt>
            <dd><time dateTime={value.observed_at}>{formatReadableTimestamp(value.observed_at)}</time></dd>
            <dt>신선도</dt><dd>{value.proof_level === "isolated-fixture"
              ? describeFixtureFreshness() : describeNativeObservationFreshness()}</dd></>}
        </dl>
        {value?.proof_level === "isolated-fixture" && value.crm.state === "read"
          && <section aria-labelledby="mail-candidates-recent-title">
          <h3 id="mail-candidates-recent-title">CRM 최근 {MAIL_CANDIDATE_RECENT_LIMIT}건 제목</h3>
          {value.crm.recent.length === 0 ? <p>메일 후보 없음</p>
            : <ol>{value.crm.recent.map(row => <li key={row.candidate_id} data-candidate-id={row.candidate_id}>
              <span>{row.title}</span>{" · "}<time dateTime={row.received_at}>{formatReadableDate(row.received_at)}</time>
            </li>)}</ol>}
        </section>}
        {value?.proof_level === "native-read" && value.crm.state === "read"
          && <section aria-labelledby="mail-candidates-recent-title">
          <h3 id="mail-candidates-recent-title">CRM 최근 {MAIL_CANDIDATE_RECENT_LIMIT}건</h3>
          <p>제목 읽기 권한 없음 · 원본이 허용한 후보 메타데이터만 표시</p>
          <p data-testid="crm-readable-summary">{(() => {
            const unconfirmed = value.crm.recent.filter(row => !row.confirmed);
            const limited = value.crm.candidate_count > value.crm.recent.length;
            const oldest = limited ? undefined : unconfirmed.at(-1);
            const age = oldest === undefined ? undefined : elapsedDays(oldest.createdAt, value.observed_at);
            const count = limited ? `최근 ${MAIL_CANDIDATE_RECENT_LIMIT}건 중 확인 필요 ${unconfirmed.length}건`
              : `확인 필요 ${unconfirmed.length}건`;
            const noUnconfirmed = !limited && unconfirmed.length === 0;
            const oldestLabel = noUnconfirmed ? "가장 오래된 미확인 항목 없음"
              : age === undefined ? "가장 오래된 것 확인 필요" : `가장 오래된 것 ${age}일`;
            const action = unconfirmed.length > 0 || limited ? "다음 행동: CRM에서 확인" : "다음 행동: 없음";
            return `${count} · ${oldestLabel} · ${action}`;
          })()}</p>
          {value.crm.recent.length === 0 ? <p>메일 후보 없음</p>
            : <ol>{value.crm.recent.map(row => <li key={row.id} data-candidate-id={row.id}>
              <span>{row.confirmed ? "CRM에서 확인됨" : "확인 필요"}</span>{" · "}
              <time dateTime={row.createdAt}>{formatReadableDate(row.createdAt)}</time>
              <details><summary>후보 원본 정보</summary><dl className="identity-list">
                <dt>ID</dt><dd>{row.id}</dd><dt>원본 상태</dt><dd>{row.status}</dd>
                <dt>확인값</dt><dd>{String(row.confirmed)} · 업무 승인 아님</dd><dt>신선도</dt><dd>{row.freshness}</dd>
              </dl></details>
            </li>)}</ol>}
        </section>}
        <p>두 후보함은 서로 다른 원본입니다. 건수를 합산하거나 회사기억 수신을 업무 승인·재무 효과로 처리하지 않습니다.</p>
      </div>
    </article>
  </section>;
}
