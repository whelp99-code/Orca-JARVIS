import type { ControlRequestListResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityIdFactory, AuthorityMutationClient } from "../authority-api.js";
import { AuthorityControls } from "../authority-controls.js";
import type { ResourceState } from "../store.js";

export type ApprovalsPageProps = Readonly<{
  state: ResourceState<ControlRequestListResponse>;
  client: Pick<AuthorityMutationClient, "decideRequest" | "executeRequest" | "retryRequest">;
  idFactory?: AuthorityIdFactory;
}>;

export function ApprovalsPage({ state, client, idFactory }: ApprovalsPageProps) {
  switch (state.status) {
    case "idle":
    case "loading":
      return <PageState title="Approvals" message="Loading approvals" busy />;
    case "retrying":
      return <PageState title="Approvals" message="Retrying approvals" busy />;
    case "error":
      return <PageState title="Unable to load approvals" message={state.error.message} />;
    case "success":
    case "empty":
      return (
        <section className="page-frame dashboard-main" aria-label="Approvals">
          <h1>Approvals</h1>
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

function PageState({ title, message, busy = false }: Readonly<{
  title: string;
  message: string;
  busy?: boolean;
}>) {
  return (
    <main className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected approvals state: ${JSON.stringify(value)}`);
}
