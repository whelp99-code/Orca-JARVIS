import type { DashboardErrorEnvelope } from "../../../src/dashboard/http.js";
import type { TerminalLogResponse } from "../../../src/dashboard/terminal-reader.js";
import type { ResourceState } from "../store.js";

type TerminalLogProps =
  | TerminalLogResponse
  | Readonly<{
      error: DashboardErrorEnvelope;
      onRetry?: () => void;
    }>
  | Readonly<{
      state: ResourceState<TerminalLogResponse>;
      onRetry?: () => void;
    }>;

export function TerminalLog(props: TerminalLogProps) {
  if ("error" in props) {
    return (
      <section className="panel" aria-label="Terminal log">
        <header className="panel-header"><h2>Terminal log</h2></header>
        <div className="panel-body" role="alert">
          <p className="empty-state">{props.error.error.message}</p>
          {props.onRetry === undefined ? null : (
            <button type="button" onClick={props.onRetry}>Retry</button>
          )}
        </div>
      </section>
    );
  }

  let response: TerminalLogResponse;
  if ("state" in props) {
    switch (props.state.status) {
      case "idle":
      case "loading":
        return (
          <section className="panel" aria-label="Terminal log" aria-busy="true">
            <header className="panel-header"><h2>Terminal log</h2></header>
            <p className="empty-state">Loading terminal log</p>
          </section>
        );
      case "retrying":
        return (
          <section className="panel" aria-label="Terminal log" aria-busy="true">
            <header className="panel-header"><h2>Terminal log</h2></header>
            <p className="empty-state">Retrying terminal log</p>
          </section>
        );
      case "error":
        return (
          <section className="panel" aria-label="Terminal log">
            <header className="panel-header"><h2>Terminal log</h2></header>
            <div className="panel-body" role="alert">
              <p className="empty-state">
                {props.state.kind === "not_found" ? "Terminal log not found" : props.state.error.message}
              </p>
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
    <section className="panel" aria-label="Terminal log">
      <header className="panel-header">
        <h2>Terminal log</h2>
        <p className="record-meta">Status: {response.status}</p>
      </header>
      <div className="panel-body">
        {response.lines.length === 0 ? (
          <p className="empty-state" role="status">No log output</p>
        ) : (
          <pre role="log" aria-label="Terminal output" aria-live="polite">{response.lines.join("\n")}</pre>
        )}
        {response.truncated ? <p className="record-meta">Earlier lines omitted</p> : null}
      </div>
    </section>
  );
}
