import { Link } from "react-router-dom";
import type { TaskListResponse } from "../../../src/dashboard/read-model.js";
import type { ResourceState } from "../store.js";

type TaskNavigationProps = Readonly<{
  taskHref?: (taskId: string) => string;
}>;

type TaskListPageProps = TaskNavigationProps & (
  | TaskListResponse
  | Readonly<{
      state: ResourceState<TaskListResponse>;
      onRetry?: () => void;
    }>
);

export function TaskListPage(props: TaskListPageProps) {
  let response: TaskListResponse;

  if ("state" in props) {
    switch (props.state.status) {
      case "idle":
      case "loading":
        return (
          <section className="page-frame dashboard-main" aria-label="Tasks" aria-busy="true">
            <h1>Tasks</h1>
            <p className="empty-state">Loading tasks</p>
          </section>
        );
      case "retrying":
        return (
          <section className="page-frame dashboard-main" aria-label="Tasks" aria-busy="true">
            <h1>Tasks</h1>
            <p className="empty-state">Retrying tasks</p>
          </section>
        );
      case "error":
        return (
          <section className="page-frame dashboard-main" aria-label="Tasks">
            <h1>Tasks</h1>
            <div role="alert" className="panel">
              <p className="empty-state">{props.state.error.message}</p>
              {props.onRetry === undefined ? null : (
                <button type="button" onClick={props.onRetry}>Retry</button>
              )}
            </div>
          </section>
        );
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

  return (
    <section className="page-frame dashboard-main" aria-label="Tasks">
      <h1>Tasks</h1>
      {response.items.length === 0 ? (
        <p className="empty-state" role="status">No tasks</p>
      ) : (
        <ul className="record-list">
          {response.items.map((task) => {
            const href = props.taskHref?.(task.task_id);
            return (
              <li className="record" key={task.task_id}>
                <article>
                  <h2 className="record-title">
                    {href === undefined ? task.title : <Link to={href}>{task.title}</Link>}
                  </h2>
                  <div className="record-meta">
                    <span>{task.kind}</span>
                    <span className="connection-state" data-state={task.state} aria-label={`Status: ${task.state}`}>
                      <span className="connection-icon" aria-hidden="true" />
                      <span>{task.state}</span>
                    </span>
                    <time dateTime={task.updated_at}>{task.updated_at}</time>
                    {task.pending_approval ? <span>Approval pending</span> : null}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
