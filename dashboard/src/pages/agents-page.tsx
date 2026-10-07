import { Link } from "react-router-dom";
import type { AgentListResponse } from "../../../src/dashboard/read-model.js";
import { copy } from "../copy.js";
import type { ResourceState } from "../store.js";

type AgentNavigationProps = Readonly<{
  agentHref?: (agentId: string) => string;
  onAgentSelect?: (agentId: string) => void;
}>;

type AgentsPageProps = AgentNavigationProps & (
  | AgentListResponse
  | Readonly<{
      state: ResourceState<AgentListResponse>;
      onRetry?: () => void;
    }>
);

export function AgentsPage(props: AgentsPageProps) {
  let response: AgentListResponse;

  if ("state" in props) {
    switch (props.state.status) {
      case "idle":
      case "loading":
        return (
          <section className="page-frame dashboard-main" aria-label={copy.pages.agents} aria-busy="true">
            <h1>{copy.pages.agents}</h1>
            <p className="empty-state">Loading agents</p>
          </section>
        );
      case "retrying":
        return (
          <section className="page-frame dashboard-main" aria-label={copy.pages.agents} aria-busy="true">
            <h1>{copy.pages.agents}</h1>
            <p className="empty-state">에이전트를 다시 불러오는 중</p>
          </section>
        );
      case "error":
        return (
          <section className="page-frame dashboard-main" aria-label={copy.pages.agents}>
            <h1>{copy.pages.agents}</h1>
            <div role="alert" className="panel">
              <p className="empty-state">{props.state.error.message}</p>
              {props.onRetry === undefined ? null : (
                <button type="button" onClick={props.onRetry}>{copy.retry}</button>
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

  const onAgentSelect = props.onAgentSelect;

  return (
    <section className="page-frame dashboard-main" aria-label={copy.pages.agents}>
      <h1>{copy.pages.agents}</h1>
      {response.items.length === 0 ? (
        <p className="empty-state" role="status">No agents connected</p>
      ) : (
        <ul className="agent-list">
          {response.items.map((agent) => {
            const href = props.agentHref?.(agent.agent_id);
            return (
              <li className="agent-record" key={agent.agent_id}>
                <article>
                  <header className="agent-heading">
                    <h2 className="record-title">{agent.provider}</h2>
                    <span className="agent-status">{agent.status}</span>
                  </header>
                  <dl className="identity-list">
                    <div><dt>Terminal</dt><dd>{agent.terminal_id}</dd></div>
                    <div><dt>Incarnation</dt><dd>{agent.incarnation_id}</dd></div>
                    <div>
                      <dt>Identity</dt>
                      <dd>
                        {href !== undefined ? (
                          <Link
                            to={href}
                            onClick={onAgentSelect === undefined ? undefined : () => onAgentSelect(agent.agent_id)}
                          >
                            {agent.agent_id}
                          </Link>
                        ) : onAgentSelect === undefined ? (
                          agent.agent_id
                        ) : (
                          <button type="button" onClick={() => onAgentSelect(agent.agent_id)}>
                            {agent.agent_id}
                          </button>
                        )}
                      </dd>
                    </div>
                    <div><dt>Path</dt><dd>{agent.canonical_path}</dd></div>
                  </dl>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
