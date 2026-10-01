import type { ControlRequestListResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityIdFactory, AuthorityMutationClient } from "../authority-api.js";
import { AuthorityControls } from "../authority-controls.js";
import { OwnerInboxPanel } from "../owner-inbox-panel.js";
import { copy } from "../copy.js";
import type { ResourceState } from "../store.js";

export type ApprovalsPageProps = Readonly<{
  state: ResourceState<ControlRequestListResponse>;
  client: Pick<AuthorityMutationClient, "decideRequest" | "executeRequest" | "retryRequest">;
  idFactory?: AuthorityIdFactory;
  onRetry?: () => void;
  onFirst?: () => void;
  onNext?: () => void;
}>;

export function ApprovalsPage({ state, client, idFactory, onRetry, onFirst, onNext }: ApprovalsPageProps) {
  switch (state.status) {
    case "idle":
    case "loading":
      return <PageState title={copy.pages.approvals} message="승인을 불러오는 중" busy />;
    case "retrying":
      return <PageState title={copy.pages.approvals} message="승인을 다시 불러오는 중" busy />;
    case "error":
      return <>
        <PageState title="승인을 열 수 없습니다" message={state.error.message} onRetry={onRetry} />
        {onFirst === undefined ? null : <button type="button" onClick={onFirst}>첫 페이지</button>}
      </>;
    case "success":
    case "empty":
      return (
        <section className="page-frame dashboard-main" aria-label={copy.pages.approvals}>
          <h1>{copy.pages.approvals}</h1>
          <OwnerInboxPanel />
          {state.data.page === undefined ? null : (
            <nav aria-label="승인 페이지" className="record-meta">
              <span>{state.data.page.returned}건 표시 / 처리 가능 {state.data.page.total}건</span>
              <button type="button" onClick={onFirst}>첫 페이지</button>
              <button type="button" disabled={!state.data.page.has_more} onClick={onNext}>다음 페이지</button>
            </nav>
          )}
          <details className="admin-tools">
            <summary>관리자 도구</summary>
            {state.data.items.length === 0 ? (
              <p className="empty-state" role="status">대기 중인 승인이 없습니다</p>
            ) : (
              <ul className="record-list panel authority-list">
                {state.data.items.map((request) => (
                  <li className="record" key={request.request_id}>
                    <AuthorityControls request={request} client={client} idFactory={idFactory} />
                  </li>
                ))}
              </ul>
            )}
          </details>
        </section>
      );
    default:
      return assertNever(state);
  }
}

function PageState({ title, message, busy = false, onRetry }: Readonly<{
  title: string;
  message: string;
  busy?: boolean;
  onRetry?: () => void;
}>) {
  return (
    <div className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        <p>{message}</p>
        {onRetry === undefined ? null : <button type="button" onClick={onRetry}>{copy.retry}</button>}
      </section>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected approvals state: ${JSON.stringify(value)}`);
}
