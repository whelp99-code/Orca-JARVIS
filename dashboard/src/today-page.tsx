import type { ReactNode } from "react";
import type { OverviewAgent, OverviewApproval, OverviewResponse, OverviewRisk } from "../../src/dashboard/read-model.js";
import type { AuthorityMutationClient } from "./authority-api.js";
import { AuthorityControls } from "./authority-controls.js";
import type { NotificationItem, PersonalClient } from "./personal-api.js";
import type { PersonalSnapshot } from "./personal-store.js";
import { RecommendationAction } from "./recommendation-action.js";
import { useSurface } from "./surface.js";

type Props = Readonly<{
  snapshot: PersonalSnapshot;
  overview?: OverviewResponse;
  approvals: readonly OverviewApproval[];
  client: PersonalClient;
  authorityClient?: AuthorityMutationClient;
  authorityConnected?: boolean;
  onRefresh: () => void;
}>;
type LoadedSnapshot = Extract<PersonalSnapshot, { readonly status: "success" | "stale" }>;
type ContentProps = Omit<Props, "snapshot"> & Readonly<{ snapshot: LoadedSnapshot }>;

export function TodayPage({
  snapshot, overview, approvals, client, authorityClient, authorityConnected, onRefresh,
}: Props) {
  switch (snapshot.status) {
    case "idle":
    case "loading":
      return <PageState busy message="Loading Today" />;
    case "error":
      return <PageState error message="Today is unavailable" />;
    case "success":
    case "stale":
      return (
        <TodayContent
          snapshot={snapshot}
          overview={overview}
          approvals={approvals}
          client={client}
          authorityClient={authorityClient}
          authorityConnected={authorityConnected}
          onRefresh={onRefresh}
        />
      );
    default:
      return assertNever(snapshot);
  }
}

function TodayContent({
  snapshot, overview, approvals, client, authorityClient, authorityConnected = true, onRefresh,
}: ContentProps) {
  const { today, decisions, notifications, health } = snapshot.data;
  // The phone gateway proxies personal reads only: no authority stream, overview, approvals or mutations.
  const phone = useSurface() === "phone";
  const authorityAvailable = !phone && snapshot.status === "success" && snapshot.connectionState === "live" && authorityConnected;
  const recommendationActionable = authorityAvailable && today.state === "ready"
    && decisions.state === "ready" && health.state !== "offline";
  return (
    <div className="page-frame dashboard-main today-page">
      <header className="today-heading">
        <div>
          <p className="today-kicker">PERSONAL OPERATING SYSTEM</p>
          <h1>Today</h1>
        </div>
        <p className="freshness-badge" data-freshness={today.state}>{today.state}</p>
      </header>
      {phone ? (
        <p className="today-alert" role="status">Read-only phone view. Owner actions are taken in the Linux control center.</p>
      ) : snapshot.status === "stale" || snapshot.connectionState !== "live" || !authorityConnected ? (
        <p className="today-alert" role="alert">Cached data is not authoritative. Actions are disabled until Linux reconnects.</p>
      ) : null}
      <div className="today-grid">
        <Section id="today-now" title="NOW">
          <dl className="identity-list today-summary">
            <div><dt>Daily run</dt><dd>{today.current_daily_run?.["state"] ?? "No active run"}</dd></div>
            <div><dt>Brief</dt><dd>{today.brief.state} / {today.brief.item_count} items</dd></div>
            <div><dt>Generated</dt><dd><time dateTime={today.generated_at}>{today.generated_at}</time></dd></div>
            <div>
              <dt>Fresh until</dt>
              <dd>{today.freshness.fresh_until === null ? "Not reported" : (
                <time dateTime={today.freshness.fresh_until}>{today.freshness.fresh_until}</time>
              )}</dd>
            </div>
            <div><dt>Notifications</dt><dd>{today.notification_summary.total} / {notifications.state}</dd></div>
            <div>
              <dt>Closeout</dt>
              <dd>{today.latest_verified_closeout === null
                ? "No verified closeout"
                : `${String(today.latest_verified_closeout.verified_completion_count)} verified`}</dd>
            </div>
          </dl>
        </Section>
        <Section id="today-blocked" title="BLOCKED" tone="warning">
          <NamedList title="Conflicts" values={today.conflicts} empty="No conflicts" />
          <NamedList title="Omissions" values={today.omissions} empty="No omissions" />
          <ul className="health-list">
            {health.items.filter((item) => item.state !== "ready" && item.state !== "fresh").map((item) => (
              <li key={`${item.kind}:${item.identity}`}>{item.identity}: {item.state}</li>
            ))}
          </ul>
        </Section>
        <Section id="today-decisions" title="DECISIONS" tone="info">
          {phone ? null : <a href="/approvals">승인 목록 전체 보기</a>}
          {decisions.items.length === 0 && approvals.length === 0 ? <p className="empty-state">No owner decisions</p> : null}
          <ul className="record-list">
            {decisions.items.map((decision) => (
              <li className="record" key={`${decision.recommendation_id}:${decision.rank}`}>
                <RecommendationAction decision={decision} client={client}
                  actionable={recommendationActionable && decision.state === "pending"
                    && decision.expires_at > today.generated_at} onSettled={onRefresh} />
              </li>
            ))}
            {authorityClient === undefined ? null : approvals.map((approval) => (
              <li className="record" key={approval.request_id}>
                <AuthorityControls request={approval} client={authorityClient} enabled={authorityAvailable} />
              </li>
            ))}
          </ul>
        </Section>
        <Section id="today-next" title="NEXT 3" tone="success">
          {today.next_actions.length === 0 ? <p className="empty-state">No ranked next actions</p> : (
            <ol className="next-list">
              {today.next_actions.map((action) => (
                <li key={`${action.recommendation_id}:${action.rank}`}>
                  <span className="next-rank">{action.rank}</span>
                  <div>
                    <p className="record-title"><CjkSafeTitle value={action.title} /></p>
                    <p className="record-meta">{action.confidence_class}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section id="today-workers" title="WORKERS">
          {phone ? <p className="empty-state">Worker state is not served to the phone.</p>
            : <WorkerList agents={overview?.agents ?? []} />}
        </Section>
        <Section id="today-risks" title="RISKS" tone="danger">
          <RiskList risks={phone ? [] : overview?.risks ?? []}
            notifications={notifications.items.filter((item) => item.state !== "delivered")}
            disconnected={!phone && snapshot.connectionState !== "live"} />
        </Section>
      </div>
    </div>
  );
}

function CjkSafeTitle({ value }: Readonly<{ value: string }>) {
  if (!/[\u3131-\uD79D]/u.test(value)) return value;
  const words = value.split(" ");
  if (words.length < 2) return value;
  const pairs: Array<{ readonly key: string; readonly text: string }> = [];
  for (let index = 0; index < words.length; index += 2) {
    const first = words[index];
    if (first === undefined) continue;
    const second = words[index + 1];
    const text = second === undefined ? first : `${first} ${second}`;
    pairs.push({ key: `${String(index)}:${text}`, text });
  }
  return pairs.map((pair, index) => (
    <span className="phrase-pair" key={pair.key}>
      {index === 0 ? "" : " "}{pair.text}
    </span>
  ));
}

function Section({ id, title, tone, children }: Readonly<{
  id: string; title: string; tone?: string; children: ReactNode;
}>) {
  return (
    <section className="panel today-section" data-tone={tone} aria-labelledby={id}>
      <header className="panel-header"><h2 id={id}>{title}</h2></header>
      <div className="panel-body today-section-body">{children}</div>
    </section>
  );
}
function NamedList({ title, values, empty }: Readonly<{
  title: string; values: readonly string[]; empty: string;
}>) {
  return (
    <details open>
      <summary>{title}</summary>
      {values.length === 0 ? <p className="empty-state">{empty}</p> : (
        <ul className="blocked-list">{values.map((value) => <li key={value}>{value}</li>)}</ul>
      )}
    </details>
  );
}
function RiskList({ risks, notifications, disconnected }: Readonly<{
  risks: readonly OverviewRisk[]; notifications: readonly NotificationItem[]; disconnected: boolean;
}>) {
  if (risks.length === 0 && notifications.length === 0 && !disconnected) {
    return <p className="empty-state">No open risks or undelivered notifications</p>;
  }
  return (
    <ul className="record-list">
      {risks.map((risk) => (
        <li className="record" key={risk.id}>
          <p className="severity-label">{risk.severity}</p>
          <p>{risk.message}</p>
        </li>
      ))}
      {notifications.map((item) => (
        <li className="record" key={item.intent_id}>{item.urgency}: {item.preview}</li>
      ))}
      {disconnected ? <li className="record">Live updates disconnected</li> : null}
    </ul>
  );
}
function WorkerList({ agents }: Readonly<{ agents: readonly OverviewAgent[] }>) {
  if (agents.length === 0) return <p className="empty-state">No active workers</p>;
  return (
    <ul className="record-list">
      {agents.map((agent) => (
        <li className="record" key={agent.agent_id}>
          <p className="record-title">{agent.provider}</p>
          <div className="record-meta">
            <span>{agent.status}</span><span>{agent.terminal_id}</span><span>{agent.agent_id}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
function PageState({ message, busy = false, error = false }: Readonly<{
  message: string; busy?: boolean; error?: boolean;
}>) {
  return (
    <div className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={error ? "alert" : "status"}><h1>Today</h1><p>{message}</p></section>
    </div>
  );
}
function assertNever(value: never): never { throw new Error(`unexpected Today state: ${JSON.stringify(value)}`); }
