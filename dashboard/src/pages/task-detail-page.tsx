import type { TaskDetailResponse } from "../../../src/dashboard/read-model.js";
import type { AuthorityIdFactory, AuthorityMutationClient } from "../authority-api.js";
import { TaskGraph } from "../components/task-graph.js";
import { TimelinePanel } from "../components/timeline-panel.js";
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
          <div className="page-frame dashboard-main" aria-busy="true">
            <h1>Task</h1>
            <p className="empty-state">Loading task</p>
          </div>
        );
      case "retrying":
        return (
          <div className="page-frame dashboard-main" aria-busy="true">
            <h1>Task</h1>
            <p className="empty-state">Retrying task</p>
          </div>
        );
      case "error": {
        const notFound = props.state.kind === "not_found";
        return (
          <div className="page-frame dashboard-main">
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
          </div>
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
    <div className="page-frame dashboard-main">
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

      <TimelinePanel
        state={events.length === 0
          ? { status: "empty", data: events }
          : { status: "success", data: events }}
      />

      <TaskGraph sourceIds={task.source_ids} />
    </div>
  );
}
