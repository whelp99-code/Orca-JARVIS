import type { TaskDetailResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityIdFactory, AuthorityMutationClient } from "../authority-api.js";
import type { ResourceState } from "../store.js";
import { TaskControl } from "../task-control.js";

type TaskDetailPageProps = (
  | TaskDetailResponse
  | Readonly<{
      state: ResourceState<TaskDetailResponse>;
      onRetry?: () => void;
    }>
) & Readonly<{
  client?: Pick<AuthorityMutationClient, "cancelTask">;
  idFactory?: AuthorityIdFactory;
}>;

export function TaskDetailPage(props: TaskDetailPageProps) {
  let response: TaskDetailResponse;

  if ("state" in props) {
    switch (props.state.status) {
      case "idle":
      case "loading":
        return (
          <main className="page-frame dashboard-main" aria-busy="true">
            <h1>Task</h1>
            <p className="empty-state">Loading task</p>
          </main>
        );
      case "retrying":
        return (
          <main className="page-frame dashboard-main" aria-busy="true">
            <h1>Task</h1>
            <p className="empty-state">Retrying task</p>
          </main>
        );
      case "error": {
        const notFound = props.state.kind === "not_found";
        return (
          <main className="page-frame dashboard-main">
            <section role="alert" className="panel">
              <header className="panel-header">
                <h1>{notFound ? "Task not found" : "Unable to load task"}</h1>
              </header>
              <div className="panel-body">
                <p className="empty-state">{props.state.error.message}</p>
                {!notFound && props.onRetry !== undefined ? (
                  <button type="button" onClick={props.onRetry}>Retry</button>
                ) : null}
              </div>
            </section>
          </main>
        );
      }
      case "success":
      case "empty":
        response = props.state.data;
        break;
      default: {
        const exhaustive: never = props.state;
        return exhaustive;
      }
    }
  } else {
    response = props;
  }

  const { task, events } = response.context;

  return (
    <main className="page-frame dashboard-main">
      <header>
        <h1>{task.title}</h1>
        <dl className="identity-list" aria-label="Task summary">
          <div><dt>Task</dt><dd>{task.task_id}</dd></div>
          <div><dt>Kind</dt><dd>{task.kind}</dd></div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="connection-state" data-state={task.state}>
                <span className="connection-icon" aria-hidden="true" />
                <span>{task.state}</span>
              </span>
            </dd>
          </div>
          <div><dt>Updated</dt><dd><time dateTime={task.updated_at}>{task.updated_at}</time></dd></div>
          <div><dt>Approval</dt><dd>{task.pending_approval ? "Pending" : "Not pending"}</dd></div>
        </dl>
      </header>

      {props.client === undefined ? null : (
        <TaskControl detail={response} client={props.client} idFactory={props.idFactory} />
      )}

      <section className="panel" aria-label="Timeline">
        <header className="panel-header"><h2>Timeline</h2></header>
        <div className="panel-body">
          {events.length === 0 ? (
            <p className="empty-state">No timeline events</p>
          ) : (
            <ol className="record-list">
              {events.map((event) => (
                <li className="record" key={event.event_id}>
                  <article>
                    <h3 className="record-title">{event.title}</h3>
                    <div className="record-meta">
                      <span>{event.source}</span>
                      <span>{event.kind}</span>
                      <span>{event.actor}</span>
                      {event.status === null ? null : <span>Status: {event.status}</span>}
                      <time dateTime={event.created_at}>{event.created_at}</time>
                    </div>
                    {event.evidence_refs.length === 0 ? null : (
                      <dl className="identity-list">
                        <div>
                          <dt>Evidence</dt>
                          <dd>{event.evidence_refs.join(", ")}</dd>
                        </div>
                      </dl>
                    )}
                  </article>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="panel" aria-label="Graph">
        <header className="panel-header"><h2>Graph</h2></header>
        <div className="panel-body">
          {task.source_ids.length === 0 ? (
            <p className="empty-state">No graph nodes</p>
          ) : (
            <ol className="record-list">
              {task.source_ids.map((sourceId, index) => (
                <li className="record" key={sourceId}>
                  <p className="record-title">Node {sourceId}</p>
                  <p className="record-meta">
                    {index === 0 ? "Graph start" : "Transition from the previous node"}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </main>
  );
}
