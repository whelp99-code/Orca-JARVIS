import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import type { DashboardTaskReadiness } from "../../src/dashboard/task-execution-service.js";
import { DashboardApiError } from "./api.js";
import type { AuthorityIdFactory, AuthorityMutationClient, TaskExecutionClient } from "./authority-api.js";
import { AuthorityControls } from "./authority-controls.js";
import type { createDashboardStore } from "./store.js";
import { TaskExecutionForm } from "./task-execution-form.js";
import { taskExecutionMessage } from "./task-execution-message.js";
import { TaskExecutionPlanView } from "./task-execution-plan-view.js";
import "./task-execution.css";
import { TaskTemplateSummary } from "./task-template-summary.js";

type Store = ReturnType<typeof createDashboardStore>;
export function TaskExecutionPanel({ taskId, store, client, idFactory }: Readonly<{
  taskId: string; store: Store; client: AuthorityMutationClient; idFactory?: AuthorityIdFactory;
}>) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const snapshot = state.taskExecution;
  const pending = state.taskExecutionOperations?.filter(item => item.taskId === taskId) ?? [];
  const execution = client.taskExecution;
  const executionClient = useMemo(() => execution ? { ...execution,
    stage: (...args: Parameters<TaskExecutionClient["stage"]>) => store.runTaskExecutionOperation(
      { taskId: args[0], requestId: args[1].request_id, kind: "stage" }, () => execution.stage(...args)),
  } : undefined, [execution, store]);
  useEffect(() => execution ? store.watchTaskExecution(taskId, execution.read) : undefined, [taskId, execution, store]);
  const controls = useMemo(() => ({
    decideRequest: async (...args: Parameters<AuthorityMutationClient["decideRequest"]>) => {
      try { return await client.decideRequest(...args); } finally { await store.refreshTaskExecution(); }
    },
    executeRequest: async (...args: Parameters<AuthorityMutationClient["executeRequest"]>) => {
      try { return await store.runTaskExecutionOperation({ taskId, requestId: args[0], kind: "execute" },
        () => client.executeRequest(...args)); } finally { await store.refreshTaskExecution(); }
    },
    retryRequest: client.retryRequest,
  }), [client, store, taskId]);
  const value = snapshot?.task_id === taskId ? snapshot : undefined;
  const resource = value?.resource;
  const data = resource?.status === "success" || resource?.status === "empty" ? resource.data : undefined;
  const eligible = data?.runs.filter(run => ["running", "waiting_approval"].includes(run.state)
    && !data.requests.some(item => item.plan.run_id === run.run_id && !["rejected", "cancelled"].includes(item.request.state))) ?? [];
  return <section className="panel task-execution" aria-label="작업 실행">
    <header className="panel-header"><h2>작업 실행</h2>
      <button type="button" disabled={!execution || value?.refreshing} onClick={() => { void store.refreshTaskExecution(); }}>실행 상태 새로고침</button>
    </header>
    <div className="panel-body control-panel-body">
      {!execution ? <p>작업 실행 연결을 사용할 수 없습니다.</p> : !resource || ["idle", "loading", "retrying"].includes(resource.status)
        ? <p role="status">실행 정보를 불러오는 중입니다.</p> : null}
      {resource?.status === "error" ? <p role="alert">{resource.kind === "not_found"
        ? "이 작업에 연결된 실행 흐름이 없습니다. 먼저 작업 시작 요청을 승인하고 실행하세요."
        : "실행 상태를 확인하지 못했습니다. 새로고침해 다시 조회하세요."}</p> : null}
      {value?.refreshing && data ? <p role="status">최신 실행 상태를 확인하는 중입니다.</p> : null}
      {pending.map(item => <p role="status" key={`${item.kind}:${item.requestId}`}>전송 이력을 보존 중입니다: {item.requestId}.
        서버 상태가 확인될 때까지 추가 전송을 차단합니다. 실행 상태 새로고침으로 확인하세요.</p>)}
      {data?.truncated.runs || data?.truncated.requests ? <p role="status">최근 20개 항목을 표시합니다. 전체 이력은 작업 타임라인에서 확인하세요.</p> : null}
      {data && eligible.length === 0 && data.requests.length === 0 ? <p>현재 실행 계획을 준비할 수 있는 작업 흐름이 없습니다.</p> : null}
      {executionClient && eligible.length > 0 ? <TaskExecutionForm taskId={taskId} runs={eligible.map(run => run.run_id)}
        templates={Object.fromEntries(eligible.flatMap(run => run.task_template ? [[run.run_id, run.task_template]] : []))}
        client={executionClient} refresh={store.refreshTaskExecution} enabled={!value?.refreshing && pending.length === 0} idFactory={idFactory} /> : null}
      {execution && data?.requests.map(item => <ExecutionRequest key={item.request.request_id} taskId={taskId} item={item}
        client={execution} controls={controls} enabled={!value?.refreshing && !pending.some(operation =>
          operation.kind === "stage" || operation.requestId === item.request.request_id)} refresh={store.refreshTaskExecution} />)}
    </div>
  </section>;
}

function ExecutionRequest({ taskId, item, client, controls, enabled, refresh }: Readonly<{
  taskId: string; item: DashboardTaskExecution["requests"][number]; client: TaskExecutionClient;
  controls: Pick<AuthorityMutationClient, "decideRequest" | "executeRequest" | "retryRequest">;
  enabled: boolean; refresh: () => Promise<void>;
}>) {
  const [readiness, setReadiness] = useState<DashboardTaskReadiness>();
  const [checking, setChecking] = useState(false); const [error, setError] = useState("");
  const active = ["pending", "approved"].includes(item.request.state);
  async function check() {
    if (item.plan.schema_version !== 2 || checking || !enabled) return;
    setChecking(true); setError(""); setReadiness(undefined);
    try { setReadiness(await client.check(taskId, item.plan)); }
    catch (caught) { setError(taskExecutionMessage(caught)); }
    finally { setChecking(false); }
  }
  return <article className="execution-request" aria-label={`실행 요청 ${item.request.request_id}`}>
    <h3>{item.completion ? "검증된 실행 결과" : "실행 요청"}</h3>
    {item.task_template ? <TaskTemplateSummary template={item.task_template} /> : null}
    <details open={active}><summary>승인할 파일·검사·결과 브랜치</summary><TaskExecutionPlanView plan={item.plan} /></details>
    <details><summary>승인 식별 정보</summary><dl className="identity-list">
      <div><dt>명령 해시</dt><dd>{item.command_digest}</dd></div>
      <div><dt>승인 기한</dt><dd>{item.expires_at}</dd></div>
    </dl></details>
    {active && item.plan.schema_version === 2 ? <div>
      <button type="button" disabled={checking || !enabled} onClick={() => { void check(); }}>실행 환경 확인</button>
      {checking ? <p role="status">실행 환경 확인 중</p> : null}
      {readiness ? <p role="status">{readiness.execution_available
        ? "실행 환경 검사를 통과했습니다. 모델 로그인 상태는 실제 실행에서 확인합니다."
        : taskExecutionMessage(new DashboardApiError({ kind: "server", code: readiness.readiness.reason_code ?? "UNKNOWN",
          message: "", request_id: "" }))}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
    <AuthorityControls key={`${item.request.request_id}:${item.request.state}`} request={item.request} client={controls}
      enabled={enabled && item.plan.schema_version === 2} onRefresh={refresh} taskExecutionContext />
    {item.request.state === "claimed" ? <p role="status">서버에서 실행 중입니다. 페이지를 닫아도 실행은 취소되지 않습니다.</p> : null}
    {item.request.state === "uncertain" ? <p role="alert">실행 결과가 미확정입니다. 저장된 증거를 확인한 뒤 복구해야 합니다.</p> : null}
    {item.request.state === "failed" ? <p role="alert">검증된 완료 결과가 없습니다. 작업 타임라인에서 실패 원인을 확인하세요.</p> : null}
    {item.plan.schema_version === 1 ? <p>이전 후보 전용 계획입니다. 검증 결과 게시에는 새 작업 계획과 승인이 필요합니다.</p> : null}
    {item.completion ? <dl className="identity-list execution-result" aria-label="검증된 결과">
      <div><dt>결과 커밋</dt><dd>{item.completion.commit}</dd></div>
      <div><dt>결과 브랜치</dt><dd>{item.completion.ref}</dd></div>
      <div><dt>완료 시각</dt><dd>{item.completion.completed_at}</dd></div>
      <div><dt>완료 영수증</dt><dd>{item.completion.completion_id}</dd></div>
      <div><dt>독립 검증</dt><dd>{item.completion.verification_id}</dd></div>
    </dl> : null}
  </article>;
}
