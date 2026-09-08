import type { ControlRequestListResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityIdFactory, AuthorityMutationClient } from "../authority-api.js";
import { AuthorityControls } from "../authority-controls.js";
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
      return <PageState title="Approvals" message="Loading approvals" busy />;
    case "retrying":
      return <PageState title="Approvals" message="Retrying approvals" busy />;
    case "error":
      return <>
        <PageState title="Unable to load approvals" message={state.error.message} onRetry={onRetry} />
        {onFirst === undefined ? null : <button type="button" onClick={onFirst}>First page</button>}
      </>;
    case "success":
    case "empty":
      return (
        <section className="page-frame dashboard-main" aria-label="Approvals">
          <h1>Approvals</h1>
          {state.data.page === undefined ? null : (
            <nav aria-label="Approval pages" className="record-meta">
              <span>{state.data.page.returned} shown / {state.data.page.total} actionable requests</span>
              <button type="button" onClick={onFirst}>First page</button>
              <button type="button" disabled={!state.data.page.has_more} onClick={onNext}>Next page</button>
            </nav>
          )}
          {state.data.items.length === 0 ? (
            <p className="empty-state" role="status">No approval requests</p>
          ) : (
            <ul className="record-list panel authority-list">
              {state.data.items.map((request) => (
                <li className="record" key={request.request_id}>
                  <AuthorityControls request={request} client={client} idFactory={idFactory} />
                </li>
              ))}
            </ul>
          )}
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
        {onRetry === undefined ? null : <button type="button" onClick={onRetry}>Retry</button>}
      </section>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected approvals state: ${JSON.stringify(value)}`);
}
