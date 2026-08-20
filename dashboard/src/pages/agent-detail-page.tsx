import { useCallback, useState } from "react";
import { useParams } from "react-router-dom";
import type { AgentListResponse } from "../../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../../src/dashboard/terminal-reader.js";
import { TerminalLog } from "../components/terminal-log.js";
import type { ResourceState } from "../store.js";
import { useDetailResource } from "../use-detail-resource.js";

export type AgentDetailPageProps = Readonly<{
  agents: ResourceState<AgentListResponse>;
  loadLogs: (agentId: string, limit?: number) => Promise<TerminalLogResponse>;
}>;

const LOG_LIMIT = 500;

export function AgentDetailPage(props: AgentDetailPageProps) {
  const { agentId } = useParams<"agentId">();
  if (agentId === undefined) return <PageState title="Agent not found" />;
  return <AgentDetailContent key={agentId} agentId={agentId} {...props} />;
}

function AgentDetailContent({ agentId, agents, loadLogs }: AgentDetailPageProps & Readonly<{ agentId: string }>) {
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const loadBoundedLogs = useCallback(
    async (id: string) => await loadLogs(id, LOG_LIMIT),
    [loadLogs],
  );
  const logs = useDetailResource(agentId, loadBoundedLogs, hasLogLines, String(logRefreshKey));

  switch (agents.status) {
    case "idle":
    case "loading":
      return <PageState title="Agent" message="Loading agent identity" busy />;
    case "retrying":
      return <PageState title="Agent" message="Retrying agent identity" busy />;
    case "error":
      return <PageState title="Unable to load agent" message={agents.error.message} />;
    case "success":
    case "empty": {
      const agent = agents.data.items.find((item) => item.agent_id === agentId);
      if (agent === undefined) return <PageState title="Agent not found" />;
      return (
        <div className="page-frame dashboard-main">
          <header className="detail-header">
            <h1>{agent.provider}</h1>
            <dl className="identity-list" aria-label="Agent identity">
              <div><dt>Terminal</dt><dd>{agent.terminal_id}</dd></div>
              <div><dt>Incarnation</dt><dd>{agent.incarnation_id}</dd></div>
              <div><dt>Identity</dt><dd>{agent.agent_id}</dd></div>
              <div><dt>Path</dt><dd>{agent.canonical_path}</dd></div>
            </dl>
          </header>
          <TerminalLog state={logs} onRetry={() => { setLogRefreshKey((count) => count + 1); }} />
        </div>
      );
    }
    default:
      return assertNever(agents);
  }
}

function PageState({ title, message = "The requested route is unavailable.", busy = false }: Readonly<{
  title: string;
  message?: string;
  busy?: boolean;
}>) {
  return (
    <div className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        <p>{message}</p>
      </section>
    </div>
  );
}

function hasLogLines(response: TerminalLogResponse): boolean {
  return response.lines.length > 0;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected agent state: ${JSON.stringify(value)}`);
}
