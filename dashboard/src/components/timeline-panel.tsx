import type { TaskDetailEvent } from "../../../src/dashboard/read-model.js";
import type { ResourceState } from "../store.js";

type TimelinePanelProps = Readonly<{
  state: ResourceState<readonly TaskDetailEvent[]>;
}>;

export function TimelinePanel({ state }: TimelinePanelProps) {
  switch (state.status) {
    case "idle":
    case "loading":
      return <TimelineState message="Loading timeline" busy />;
    case "retrying":
      return <TimelineState message="Retrying timeline" busy />;
    case "error":
      return <TimelineState message={state.error.message} error />;
    case "success":
    case "empty":
      if (state.data.length === 0) return <TimelineState message="No timeline events" />;
      return (
        <section className="panel" aria-label="Task timeline">
          <header className="panel-header"><h2>Timeline</h2></header>
          <div className="panel-body">
            <ol className="record-list timeline-list">
              {state.data.map((event) => (
                <li className="record timeline-event" key={event.event_id}>
                  <article>
                    <h3 className="record-title">{event.title}</h3>
                    <div className="record-meta">
                      <span>{event.source}</span>
                      <span>{event.status ?? "Status not reported"}</span>
                      <time dateTime={event.created_at}>{event.created_at}</time>
                    </div>
                    {event.evidence_refs.length === 0 ? null : (
                      <dl className="identity-list timeline-evidence">
                        <div>
                          <dt>Evidence</dt>
                          <dd>
                            {event.evidence_refs.map((reference) => (
                              <span key={reference}>{reference}</span>
                            ))}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </article>
                </li>
              ))}
            </ol>
          </div>
        </section>
      );
    default:
      return assertNever(state);
  }
}

function TimelineState({ message, busy = false, error = false }: Readonly<{
  message: string;
  busy?: boolean;
  error?: boolean;
}>) {
  return (
    <section className="panel" aria-label="Task timeline" aria-busy={busy || undefined}>
      <header className="panel-header"><h2>Timeline</h2></header>
      <p className="empty-state" role={error ? "alert" : "status"}>{message}</p>
    </section>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected timeline state: ${JSON.stringify(value)}`);
}
