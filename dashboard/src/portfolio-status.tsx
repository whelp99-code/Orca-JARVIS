import type {
  PortfolioHostOverview,
  PortfolioOverview,
  PortfolioSummaryOverview,
} from "../../src/dashboard/portfolio-contracts.js";
import { copy, freshnessLabel, hostLabel, milestoneStateLabel } from "./copy.js";

type PortfolioStatusProps = Readonly<{ portfolio: PortfolioOverview }>;

export function PortfolioStatus({ portfolio }: PortfolioStatusProps) {
  return (
    <section className="portfolio-panel" aria-labelledby="portfolio-status-title">
      <header className="portfolio-heading">
        <div>
          <p className="portfolio-eyebrow">{copy.portfolio.kicker}</p>
          <h2 id="portfolio-status-title">{copy.portfolio.title}</h2>
        </div>
        <p>{copy.portfolio.lead}</p>
      </header>

      <div className="portfolio-hosts">
        {portfolio.hosts.map(host => <HostStatus host={host} key={host.environment} />)}
      </div>

      {portfolio.summary === null
        ? (
          <section className="portfolio-summary-empty" aria-labelledby="portfolio-progress-title">
            <h3 id="portfolio-progress-title">{copy.portfolio.milestones}</h3>
            <p className="empty-state">{copy.portfolio.unavailable}</p>
          </section>
        )
        : <PortfolioProgress summary={portfolio.summary} />}
    </section>
  );
}

function HostStatus({ host }: Readonly<{ host: PortfolioHostOverview }>) {
  const available = host.worktree_count !== null;
  return (
    <article className="portfolio-host" data-freshness={host.freshness}>
      <header>
        <h3>{hostLabel(host.environment, host.label)}</h3>
        <span className="freshness-badge">{freshnessLabel(host.freshness)}</span>
      </header>
      {host.updated_at === null
        ? <p className="portfolio-updated">{copy.portfolio.noReport}</p>
        : (
          <p className="portfolio-updated">
            {copy.portfolio.updated} <time dateTime={host.updated_at}>{formatTimestamp(host.updated_at)}</time>
          </p>
        )}
      {available
        ? (
          <dl className="portfolio-metrics">
            {copy.portfolio.metrics.map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{host[key]}</dd>
              </div>
            ))}
          </dl>
        )
        : <p className="empty-state">{copy.portfolio.unavailable}</p>}
      {host.collector_error === null
        ? null
        : <p className="portfolio-error">{copy.portfolio.collector}: {host.collector_error}</p>}
    </article>
  );
}

function PortfolioProgress({ summary }: Readonly<{ summary: PortfolioSummaryOverview }>) {
  return (
    <div className="portfolio-summary">
      <section aria-labelledby="github-work-title">
        <h3 id="github-work-title">{copy.portfolio.github}</h3>
        <dl className="github-metrics">
          <div><dt>{copy.portfolio.issues}</dt><dd>{summary.github.issue_count}</dd></div>
          <div><dt>{copy.portfolio.pulls}</dt><dd>{summary.github.pull_request_count}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="milestones-title">
        <h3 id="milestones-title">{copy.portfolio.milestones}</h3>
        {summary.milestones.length === 0
          ? <p className="empty-state">{copy.portfolio.unavailable}</p>
          : (
            <ul className="portfolio-list">
              {summary.milestones.map(item => (
                <li key={`${item.title}:${item.state}`}>
                  <span>{item.title}</span>
                  <span className="milestone-state" data-state={item.state}>{milestoneStateLabel(item.state)}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section aria-labelledby="blockers-title">
        <h3 id="blockers-title">{copy.portfolio.blockers}</h3>
        {summary.blockers.length === 0
          ? <p className="empty-state">막힌 일이 없습니다</p>
          : (
            <ul className="portfolio-list portfolio-blockers">
              {summary.blockers.map(item => <li key={item.title}>{item.title}</li>)}
            </ul>
          )}
      </section>
    </div>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
