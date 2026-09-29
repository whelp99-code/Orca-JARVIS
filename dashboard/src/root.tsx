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
import { MemoryRoute, type MemoryClientRuntime } from "./memory-route.js";
import { OperationalShell } from "./operational-shell.js";
import { AgentDetailPage } from "./pages/agent-detail-page.js";
import { AgentsPage } from "./pages/agents-page.js";
import { ApprovalsPage } from "./pages/approvals-page.js";
import { createBrowserSecurityClient, SecurityPage } from "./pages/security-page.js";
import { TaskDetailPage } from "./pages/task-detail-page.js";
import { TaskListPage } from "./pages/task-list-page.js";
import { ProposalPage } from "./proposal-page.js";
import { SurfaceContext, type DashboardSurface } from "./surface.js";
import { TodayRoute, type PersonalRuntime } from "./today-route.js";
import type { createDashboardStore, DashboardState, ResourceState } from "./store.js";
import { useDetailResource } from "./use-detail-resource.js";
import { TaskExecutionPanel } from "./task-execution-panel.js";

type DashboardStore = ReturnType<typeof createDashboardStore>;
type RootClient = Omit<DashboardClient, "agentLogs"> & Readonly<{
  agentLogs: (agentId: string, limit?: number) => Promise<TerminalLogResponse>;
}>;
type ControlCenterRootProps = Readonly<{
  store: DashboardStore;
  client: RootClient;
  authorityClient?: AuthorityMutationClient;
  authorityIdFactory?: AuthorityIdFactory;
  personalRuntime?: PersonalRuntime;
  memoryRuntime?: MemoryClientRuntime;
  initialPath?: string;
  surface?: DashboardSurface;
}>;
export function ControlCenterRoot({
  store,
  client,
  authorityClient,
  authorityIdFactory,
  personalRuntime,
  memoryRuntime,
  initialPath,
  surface = "local",
}: ControlCenterRootProps) {
  const content = (
    <SurfaceContext.Provider value={surface}>
      <ControlCenter
        store={store}
        client={client}
        authorityClient={authorityClient}
        authorityIdFactory={authorityIdFactory}
        personalRuntime={personalRuntime}
        memoryRuntime={memoryRuntime}
        surface={surface}
      />
    </SurfaceContext.Provider>
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
  personalRuntime,
  memoryRuntime,
  surface,
}: Omit<ControlCenterRootProps, "initialPath"> & Readonly<{ surface: DashboardSurface }>) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const proposalClient = useMemo(() => createProposalMutationClient(client.session), [client]);
  const liveAuthorityClient = useMemo(
    () => authorityClient ?? createAuthorityMutationClient(client.session),
    [authorityClient, client],
  );
  const phone = surface === "phone";

  // The gateway proxies no overview, task, agent or approval route and no event stream.
  useEffect(() => {
    if (phone) return undefined;
    store.start();
    return () => store.stop();
  }, [store, phone]);

  const today = (
    <TodayRoute runtime={personalRuntime} overview={state.overview} approvals={state.approvals}
      authorityClient={liveAuthorityClient} authorityConnection={state.connectionState} />
  );
  const memory = <MemoryRoute runtime={memoryRuntime} />;
  const security = <SecurityPage client={createBrowserSecurityClient()} />;
  if (phone) {
    return (
      <OperationalShell connectionState={state.connectionState}>
        <Routes>
          <Route path="/" element={today} />
          <Route path="/memory" element={memory} />
          <Route path="/security" element={security} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </OperationalShell>
    );
  }
  return (
    <OperationalShell connectionState={state.connectionState}>
      <Routes>
        <Route path="/" element={today} />
        <Route path="/memory" element={memory} />
        <Route path="/overview" element={<OverviewRoute state={state} store={store} />} />
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
              store={store}
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
              onFirst={() => { void store.firstApprovals(); }}
              onNext={() => { void store.nextApprovals(); }}
            />
          )}
        />
        <Route path="/security" element={security} />
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
      return <App overview={state.overview.data} onRefresh={() => store.refreshOverview()} />;
    default:
      return assertNever(state.overview);
  }
}

function TaskDetailRoute({
  store,
  client,
  tasks,
  authorityClient,
  authorityIdFactory,
}: Readonly<{
  store: DashboardStore;
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
      store={store}
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
  store,
  taskId,
  loadTask,
  revision,
  authorityClient,
  authorityIdFactory,
}: Readonly<{
  store: DashboardStore;
  taskId: string;
  loadTask: (id: string) => Promise<TaskDetailResponse>;
  revision?: string;
  authorityClient: AuthorityMutationClient;
  authorityIdFactory?: AuthorityIdFactory;
}>) {
  const execution = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).taskExecution;
  const executionData = execution?.task_id === taskId && execution.resource.status === "success" ? execution.resource.data : undefined;
  const authorityRevision = executionData?.requests.map(item => `${item.request.request_id}:${item.request.state}`).join("|") ?? "";
  return (
    <TaskDetailPage
      state={useDetailResource(taskId, loadTask, undefined, `${revision ?? ""}:${authorityRevision}`)}
      client={authorityClient}
      idFactory={authorityIdFactory}
      execution={<TaskExecutionPanel taskId={taskId} store={store} client={authorityClient} idFactory={authorityIdFactory} />}
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
