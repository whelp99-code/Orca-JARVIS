import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { BrowserRouter, MemoryRouter, NavLink, Route, Routes, useParams } from "react-router-dom";
import type {
  AgentListResponse,
  ControlRequestListResponse,
  TaskDetailResponse,
} from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import type { DashboardClient } from "./api.js";
import { createProposalMutationClient } from "./api-mutations.js";
import App from "./app.js";
import { TerminalLog } from "./components/terminal-log.js";
import { AgentsPage } from "./pages/agents-page.js";
import { TaskDetailPage } from "./pages/task-detail-page.js";
import { TaskListPage } from "./pages/task-list-page.js";
import { ProposalPage } from "./proposal-page.js";
import type { createDashboardStore, DashboardState, ResourceState } from "./store.js";
import { useDetailResource } from "./use-detail-resource.js";

type DashboardStore = ReturnType<typeof createDashboardStore>;
type RootClient = Omit<DashboardClient, "agentLogs"> & Readonly<{
  agentLogs: (agentId: string, limit?: number) => Promise<TerminalLogResponse>;
}>;
type ControlCenterRootProps = Readonly<{
  store: DashboardStore;
  client: RootClient;
  initialPath?: string;
}>;
type NotFoundTarget = "agent" | "page";

const LOG_LIMIT = 500;
const NAV_ITEMS = [
  { label: "Overview", to: "/" },
  { label: "Tasks", to: "/tasks" },
  { label: "New proposal", to: "/proposals" },
  { label: "Agents", to: "/agents" },
  { label: "Approvals", to: "/approvals" },
] as const;
const NOT_FOUND_TITLES = {
  agent: "Agent not found",
  page: "Page not found",
} as const satisfies Record<NotFoundTarget, string>;

export function ControlCenterRoot({ store, client, initialPath }: ControlCenterRootProps) {
  const content = <ControlCenter store={store} client={client} />;
  return initialPath === undefined ? (
    <BrowserRouter>{content}</BrowserRouter>
  ) : (
    <MemoryRouter initialEntries={[initialPath]}>{content}</MemoryRouter>
  );
}

function ControlCenter({ store, client }: Readonly<{ store: DashboardStore; client: RootClient }>) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const proposalClient = useMemo(() => createProposalMutationClient(client.session), [client]);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  return (
    <div className="control-center-root">
      <header className="control-nav">
        <nav className="page-frame control-nav-inner" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink end={item.to === "/"} key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<OverviewRoute state={state} store={store} />} />
        <Route path="/tasks" element={<TaskListPage state={state.tasks} />} />
        <Route path="/tasks/:taskId" element={<TaskDetailRoute client={client} />} />
        <Route path="/proposals" element={<ProposalPage client={proposalClient} />} />
        <Route path="/agents" element={<AgentsPage state={state.agents} />} />
        <Route path="/agents/:agentId" element={<AgentDetailRoute agents={state.agents} client={client} />} />
        <Route path="/approvals" element={<ApprovalsRoute state={state.approvals} />} />
        <Route path="*" element={<NotFoundPage target="page" />} />
      </Routes>
    </div>
  );
}

function OverviewRoute({ state, store }: Readonly<{ state: DashboardState; store: DashboardStore }>) {
  switch (state.overview.status) {
    case "idle":
    case "loading":
      return <RouteState title="JARVIS Control Center" message="Loading overview" busy />;
    case "retrying":
      return <RouteState title="JARVIS Control Center" message="Retrying overview" busy />;
    case "error":
      return (
        <RouteState
          title="Unable to load overview"
          message={state.overview.error.message}
          onRetry={() => { void store.refreshOverview(); }}
        />
      );
    case "success":
    case "empty":
      return <App overview={state.overview.data} connectionState={state.connectionState} />;
    default:
      return assertNever(state.overview);
  }
}

function TaskDetailRoute({ client }: Readonly<{ client: RootClient }>) {
  const { taskId } = useParams<"taskId">();
  const loadTask = useCallback((id: string) => client.task(id), [client]);
  if (taskId === undefined) return <NotFoundPage target="page" />;
  return <TaskDetailContent key={taskId} taskId={taskId} loadTask={loadTask} />;
}

function TaskDetailContent({ taskId, loadTask }: Readonly<{
  taskId: string;
  loadTask: (id: string) => Promise<TaskDetailResponse>;
}>) {
  return <TaskDetailPage state={useDetailResource(taskId, loadTask)} />;
}

function hasLogLines(response: TerminalLogResponse): boolean {
  return response.lines.length > 0;
}

function AgentDetailRoute({ agents, client }: Readonly<{
  agents: ResourceState<AgentListResponse>;
  client: RootClient;
}>) {
  const { agentId } = useParams<"agentId">();
  const loadLogs = useCallback((id: string) => client.agentLogs(id, LOG_LIMIT), [client]);
  if (agentId === undefined) return <NotFoundPage target="agent" />;
  return <AgentDetailContent key={agentId} agentId={agentId} agents={agents} loadLogs={loadLogs} />;
}

function AgentDetailContent({ agentId, agents, loadLogs }: Readonly<{
  agentId: string;
  agents: ResourceState<AgentListResponse>;
  loadLogs: (id: string) => Promise<TerminalLogResponse>;
}>) {
  const logs = useDetailResource(agentId, loadLogs, hasLogLines);
  switch (agents.status) {
    case "idle":
    case "loading":
      return <RouteState title="Agent" message="Loading agent identity" busy />;
    case "retrying":
      return <RouteState title="Agent" message="Retrying agent identity" busy />;
    case "error":
      return <RouteState title="Unable to load agent" message={agents.error.message} />;
    case "success":
    case "empty": {
      const agent = agents.data.items.find((item) => item.agent_id === agentId);
      if (agent === undefined) return <NotFoundPage target="agent" />;
      return (
        <main className="page-frame dashboard-main">
          <header className="detail-header">
            <h1>{agent.provider}</h1>
            <dl className="identity-list" aria-label="Agent identity">
              <div><dt>Terminal</dt><dd>{agent.terminal_id}</dd></div>
              <div><dt>Incarnation</dt><dd>{agent.incarnation_id}</dd></div>
              <div><dt>Identity</dt><dd>{agent.agent_id}</dd></div>
              <div><dt>Path</dt><dd>{agent.canonical_path}</dd></div>
            </dl>
          </header>
          <TerminalLog state={logs} />
        </main>
      );
    }
    default:
      return assertNever(agents);
  }
}

function ApprovalsRoute({ state }: Readonly<{ state: ResourceState<ControlRequestListResponse> }>) {
  switch (state.status) {
    case "idle":
    case "loading":
      return <RouteState title="Approvals" message="Loading approvals" busy />;
    case "retrying":
      return <RouteState title="Approvals" message="Retrying approvals" busy />;
    case "error":
      return <RouteState title="Unable to load approvals" message={state.error.message} />;
    case "success":
    case "empty":
      return (
        <section className="page-frame dashboard-main" aria-label="Approvals">
          <h1>Approvals</h1>
          {state.data.items.length === 0 ? (
            <p className="empty-state" role="status">No pending approvals</p>
          ) : (
            <ul className="record-list panel">
              {state.data.items.map((approval) => (
                <li className="record" key={approval.request_id}>
                  <p className="record-title">{approval.action}</p>
                  <p className="record-summary">{approval.summary}</p>
                  <div className="record-meta">
                    <span>Level {approval.action_level}</span>
                    <span>{approval.requested_by}</span>
                    <span>{approval.state}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    default:
      return assertNever(state);
  }
}

function RouteState({ title, message, busy = false, onRetry }: Readonly<{
  title: string;
  message: string;
  busy?: boolean;
  onRetry?: () => void;
}>) {
  return (
    <main className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        <p>{message}</p>
        {onRetry === undefined ? null : <button type="button" onClick={onRetry}>Retry</button>}
      </section>
    </main>
  );
}

function NotFoundPage({ target }: Readonly<{ target: NotFoundTarget }>) {
  return <RouteState title={NOT_FOUND_TITLES[target]} message="The requested route is unavailable." />;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected resource state: ${JSON.stringify(value)}`);
}
