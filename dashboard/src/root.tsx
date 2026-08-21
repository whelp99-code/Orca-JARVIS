import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { TaskDetailResponse, TaskListResponse } from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import type { DashboardClient } from "./api.js";
import { createProposalMutationClient } from "./api-mutations.js";
import {
  createAuthorityMutationClient,
  type AuthorityIdFactory,
  type AuthorityMutationClient,
} from "./authority-api.js";
import App from "./app.js";
import { OperationalShell } from "./operational-shell.js";
import { AgentDetailPage } from "./pages/agent-detail-page.js";
import { AgentsPage } from "./pages/agents-page.js";
import { ApprovalsPage } from "./pages/approvals-page.js";
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
  authorityClient?: AuthorityMutationClient;
  authorityIdFactory?: AuthorityIdFactory;
  initialPath?: string;
}>;
export function ControlCenterRoot({
  store,
  client,
  authorityClient,
  authorityIdFactory,
  initialPath,
}: ControlCenterRootProps) {
  const content = (
    <ControlCenter
      store={store}
      client={client}
      authorityClient={authorityClient}
      authorityIdFactory={authorityIdFactory}
    />
  );
  return initialPath === undefined ? (
    <BrowserRouter>{content}</BrowserRouter>
  ) : (
    <MemoryRouter initialEntries={[initialPath]}>{content}</MemoryRouter>
  );
}

function ControlCenter({
  store,
  client,
  authorityClient,
  authorityIdFactory,
}: Omit<ControlCenterRootProps, "initialPath">) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const proposalClient = useMemo(() => createProposalMutationClient(client.session), [client]);
  const liveAuthorityClient = useMemo(
    () => authorityClient ?? createAuthorityMutationClient(client.session),
    [authorityClient, client],
  );

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  return (
    <OperationalShell connectionState={state.connectionState}>
      <Routes>
        <Route path="/" element={<OverviewRoute state={state} store={store} />} />
        <Route
          path="/tasks"
          element={(
            <TaskListPage
              state={state.tasks}
              taskHref={(taskId) => `/tasks/${encodeURIComponent(taskId)}`}
              onRetry={() => { void store.refreshTasks(); }}
            />
          )}
        />
        <Route
          path="/tasks/:taskId"
          element={(
            <TaskDetailRoute
              client={client}
              tasks={state.tasks}
              authorityClient={liveAuthorityClient}
              authorityIdFactory={authorityIdFactory}
            />
          )}
        />
        <Route path="/proposals" element={<ProposalPage client={proposalClient} />} />
        <Route
          path="/agents"
          element={(
            <AgentsPage
              state={state.agents}
              agentHref={(agentId) => `/agents/${encodeURIComponent(agentId)}`}
              onRetry={() => { void store.refreshAgents(); }}
            />
          )}
        />
        <Route
          path="/agents/:agentId"
          element={<AgentDetailPage agents={state.agents} loadLogs={client.agentLogs} />}
        />
        <Route
          path="/approvals"
          element={(
            <ApprovalsPage
              state={state.approvals}
              client={liveAuthorityClient}
              idFactory={authorityIdFactory}
              onRetry={() => { void store.refreshApprovals(); }}
            />
          )}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </OperationalShell>
  );
}

function OverviewRoute({ state, store }: Readonly<{ state: DashboardState; store: DashboardStore }>) {
  switch (state.overview.status) {
    case "idle":
    case "loading":
      return <RouteState title="JARVIS 현황판" message="현황을 불러오는 중" busy />;
    case "retrying":
      return <RouteState title="JARVIS 현황판" message="현황을 다시 불러오는 중" busy />;
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
      return <App overview={state.overview.data} />;
    default:
      return assertNever(state.overview);
  }
}

function TaskDetailRoute({
  client,
  tasks,
  authorityClient,
  authorityIdFactory,
}: Readonly<{
  client: RootClient;
  tasks: ResourceState<TaskListResponse>;
  authorityClient: AuthorityMutationClient;
  authorityIdFactory?: AuthorityIdFactory;
}>) {
  const { taskId } = useParams<"taskId">();
  const loadTask = useCallback((id: string) => client.task(id), [client]);
  if (taskId === undefined) return <NotFoundPage />;
  return (
    <TaskDetailContent
      key={taskId}
      taskId={taskId}
      loadTask={loadTask}
      revision={taskRevision(tasks, taskId)}
      authorityClient={authorityClient}
      authorityIdFactory={authorityIdFactory}
    />
  );
}

function TaskDetailContent({
  taskId,
  loadTask,
  revision,
  authorityClient,
  authorityIdFactory,
}: Readonly<{
  taskId: string;
  loadTask: (id: string) => Promise<TaskDetailResponse>;
  revision?: string;
  authorityClient: AuthorityMutationClient;
  authorityIdFactory?: AuthorityIdFactory;
}>) {
  return (
    <TaskDetailPage
      state={useDetailResource(taskId, loadTask, undefined, revision)}
      client={authorityClient}
      idFactory={authorityIdFactory}
    />
  );
}

function taskRevision(state: ResourceState<TaskListResponse>, taskId: string): string | undefined {
  switch (state.status) {
    case "success":
    case "empty": {
      const task = state.data.items.find((item) => item.task_id === taskId);
      return task === undefined ? undefined : JSON.stringify(task);
    }
    case "idle":
    case "loading":
    case "retrying":
    case "error":
      return undefined;
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
    <div className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{title}</h1>
        <p>{message}</p>
        {onRetry === undefined ? null : <button type="button" onClick={onRetry}>Retry</button>}
      </section>
    </div>
  );
}

function NotFoundPage() {
  return <RouteState title="Page not found" message="The requested route is unavailable." />;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected resource state: ${JSON.stringify(value)}`);
}
