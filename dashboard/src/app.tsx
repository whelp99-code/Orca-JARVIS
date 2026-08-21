import type { ReactNode } from "react";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import { copy } from "./copy.js";
import { PortfolioStatus } from "./portfolio-status.js";

type AppProps = Readonly<{
  overview: OverviewResponse;
}>;

type PanelProps = Readonly<{
  id: string;
  title: string;
  children: ReactNode;
}>;

const SETTLED_TASK_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "rejected"]);

export default function App({ overview }: AppProps) {
  const activeWorkCount = overview.recent_tasks.filter((task) => !SETTLED_TASK_STATES.has(task.state)).length;
  const statusCards = [
    {
      id: "active-work",
      label: copy.cards.work,
      value: activeWorkCount,
      detail: activeWorkCount === 0 ? copy.cardEmpty.work : "지금 진행 중인 작업 수",
      tone: "info",
    },
    {
      id: "agents",
      label: copy.cards.agents,
      value: overview.agents.length,
      detail: "지금 붙어 있는 에이전트",
      tone: "success",
    },
    {
      id: "pending-approvals",
      label: copy.cards.approvals,
      value: overview.pending_approvals.length,
      detail: "내가 봐줘야 하는 요청",
      tone: "warning",
    },
    {
      id: "risks",
      label: copy.cards.risks,
      value: overview.risks.length,
      detail: "눈여겨볼 문제",
      tone: "danger",
    },
  ] as const;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="page-frame header-content">
          <h1>{copy.title}</h1>
        </div>
      </header>

      <div className="page-frame dashboard-main">
        <section className="status-grid" aria-label="Current status">
          {statusCards.map((card) => (
            <article
              className="status-card"
              data-tone={card.tone}
              aria-labelledby={`${card.id}-title`}
              key={card.id}
            >
              <h2 id={`${card.id}-title`}>{card.label}</h2>
              <p className="status-count">{card.value}</p>
              <p className="status-detail">{card.detail}</p>
            </article>
          ))}
        </section>

        <PortfolioStatus portfolio={overview.portfolio} />

        <div className="panel-grid">
          <Panel id="recent-title" title={copy.recent}>
            {overview.recent_tasks.length === 0 ? (
              <EmptyState>{copy.noRecent}</EmptyState>
            ) : (
              <ul className="record-list">
                {overview.recent_tasks.map((task) => (
                  <li className="record" key={task.task_id}>
                    <p className="record-title">{task.title}</p>
                    <div className="record-meta">
                      <span>{task.kind}</span>
                      <span>{task.state}</span>
                      <time dateTime={task.updated_at}>{task.updated_at}</time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel id="approvals-title" title={copy.cards.approvals}>
            {overview.pending_approvals.length === 0 ? (
              <EmptyState>{copy.noApprovals}</EmptyState>
            ) : (
              <ul className="record-list">
                {overview.pending_approvals.map((approval) => (
                  <li className="record" key={approval.request_id}>
                    <p className="record-title">{approval.action}</p>
                    <p className="record-summary">{approval.summary}</p>
                    <div className="record-meta">
                      <span>Level {approval.action_level}</span>
                      <span>{approval.requested_by}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel id="risks-title" title={copy.cards.risks}>
            {overview.risks.length === 0 ? (
              <EmptyState>{copy.noRisks}</EmptyState>
            ) : (
              <ul className="record-list">
                {overview.risks.map((risk) => (
                  <li className="record" key={risk.id}>
                    <p className="severity-label">{risk.severity}</p>
                    <p className="record-title">{risk.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel id="agents-title" title={copy.cards.agents}>
            {overview.agents.length === 0 ? (
              <EmptyState>{copy.noAgents}</EmptyState>
            ) : (
              <ul className="agent-list">
                {overview.agents.map((agent) => (
                  <li className="agent-record" key={agent.agent_id}>
                    <div className="agent-heading">
                      <p className="record-title">{agent.provider}</p>
                      <span className="agent-status">{agent.status}</span>
                    </div>
                    <dl className="identity-list">
                      <div>
                        <dt>Terminal</dt>
                        <dd>{agent.terminal_id}</dd>
                      </div>
                      <div>
                        <dt>Incarnation</dt>
                        <dd>{agent.incarnation_id}</dd>
                      </div>
                      <div>
                        <dt>Identity</dt>
                        <dd>{agent.agent_id}</dd>
                      </div>
                      <div>
                        <dt>Path</dt>
                        <dd>{agent.canonical_path}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ id, title, children }: PanelProps) {
  return (
    <section className={`panel panel-${id}`} aria-labelledby={id}>
      <header className="panel-header">
        <h3 id={id}>{title}</h3>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function EmptyState({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="empty-state">{children}</p>;
}
