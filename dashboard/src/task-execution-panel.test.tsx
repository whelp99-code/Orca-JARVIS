import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorityMutationClient, TaskExecutionClient } from "./authority-api.js";
import { DashboardApiError } from "./api.js";
import { TaskExecutionPanel } from "./task-execution-panel.js";
import { createHarness } from "./store-test-harness.js";
import { AT, COMPLETION, EMPTY, HASH, PENDING, PLAN, PREVIEW, SIGNED_RECEIPT } from "./task-execution-test-fixture.js";

afterEach(cleanup);
function harness(initial = EMPTY) {
  const store = createHarness().store;
  let data = structuredClone(initial);
  const read = vi.fn(async () => structuredClone(data));
  const prepare = vi.fn<TaskExecutionClient["prepare"]>(async () => structuredClone(PREVIEW));
  const stage = vi.fn<TaskExecutionClient["stage"]>(async (_task, body) => {
    data = { ...data, requests: [{ ...structuredClone(PENDING), plan: body.plan,
      ...(body.work_lineage ? { work_lineage: body.work_lineage } : {}), request: { ...PENDING.request, request_id: body.request_id } }] };
    return { schema_version: 1, request_id: body.request_id, action: "task.execute", action_level: 3,
      args: { plan: body.plan }, target: { task_id: "task-1", run_id: "run-1" }, state: "pending", command_digest: HASH,
      reversible: true, requested_by: "jarvis-control-center", requested_at: AT, expires_at: AT, nonce: body.nonce };
  });
  const decideRequest = vi.fn<AuthorityMutationClient["decideRequest"]>(async () => {
    data = { ...data, requests: data.requests.map(item => ({ ...item, request: { ...item.request, state: "approved" } })) };
    return { schema_version: 1, request_id: "request-ui", decision: "approve", state: "approved" };
  });
  const executeRequest = vi.fn<AuthorityMutationClient["executeRequest"]>(async () => {
    data = { ...data, runs: [{ ...data.runs[0]!, state: "completed" }], requests: [{ ...PENDING,
      request: { ...PENDING.request, state: "completed" }, completion: COMPLETION }] };
    return { schema_version: 1, execution: { request_id: "request-ui", action: "task.execute", state: "completed" } };
  });
  const client: AuthorityMutationClient = { decideRequest, executeRequest, cancelTask: vi.fn(), retryRequest: vi.fn(),
    taskExecution: { read, prepare, stage, check: vi.fn<TaskExecutionClient["check"]>(async () => ({ schema_version: 1, task_id: "task-1", run_id: "run-1",
      execution_plan_digest: HASH, execution_available: false, readiness: { state: "unavailable", provider: "claude",
        authentication: "not_probed", reason_code: "TASK_EXECUTION_NOT_CONFIGURED" } })) } };
  const view = render(<TaskExecutionPanel taskId="task-1" store={store} client={client} idFactory={kind => kind === "nonce" ? "nonce-ui" : "request-ui"} />);
  return { store, client, view, read, prepare, stage, decideRequest, executeRequest, setData: (next: typeof data) => { data = next; } };
}
async function fill() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("저장소 최상위 경로"), "/repo");
  await user.type(screen.getByLabelText("새 결과 브랜치 이름"), "result");
  await user.type(screen.getByLabelText("파일 경로 1"), "answer.mjs");
  await user.type(screen.getByLabelText("검사 인수 1"), "--check\nanswer.mjs");
  await user.click(screen.getByRole("button", { name: "계획 준비" }));
  await screen.findByRole("region", { name: "실행 계획 검토" });
  return user;
}
describe("task execution screen", () => {
  it("invalidates the preview on relationship edits and displays the submitted lineage for approval", async () => {
    const h = harness(); const user = await fill();
    await user.selectOptions(screen.getByRole("combobox", { name: "업무 관계" }), "rework");
    expect(screen.queryByRole("region", { name: "실행 계획 검토" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("이전 요청 ID"), "prior-request");
    await user.type(screen.getByLabelText("이전 요청 다이제스트"), HASH);
    await user.click(screen.getByRole("button", { name: "계획 준비" }));
    expect(within(await screen.findByRole("region", { name: "실행 계획 검토" })).getByText("기존 업무 재작업")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "검토한 계획 승인 요청" }));
    await waitFor(() => expect(h.stage).toHaveBeenCalledOnce());
    expect(h.stage.mock.calls[0]?.[1].work_lineage).toEqual({ schema_version: 1, kind: "rework",
      prior_request_id: "prior-request", prior_command_digest: HASH });
    expect(await screen.findByText("prior-request")).toBeInTheDocument();
    expect(h.decideRequest).not.toHaveBeenCalled();
    expect(h.executeRequest).not.toHaveBeenCalled();
  });
  it("prepares explicit inputs, invalidates an edited preview, then follows approval to durable result", async () => {
    const h = harness(); const user = await fill();
    expect(h.prepare).toHaveBeenLastCalledWith("task-1", { schema_version: 1, run_id: "run-1", provider: "claude",
      repository_root: "/repo", publication_ref: PLAN.publication.ref, limits: PLAN.limits,
      files: [{ path: "answer.mjs", access: "write", exists: true }], verification: PLAN.verification });
    expect(h.stage).not.toHaveBeenCalled(); expect(h.executeRequest).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("새 결과 브랜치 이름"), "-next");
    expect(screen.queryByRole("region", { name: "실행 계획 검토" })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("새 결과 브랜치 이름")); await user.type(screen.getByLabelText("새 결과 브랜치 이름"), "result");
    await user.click(screen.getByRole("button", { name: "계획 준비" }));
    await user.click(await screen.findByRole("button", { name: "검토한 계획 승인 요청" }));
    await user.click(await screen.findByLabelText("Signed receipt JSON")); await user.paste(JSON.stringify(SIGNED_RECEIPT));
    await user.click(screen.getByRole("button", { name: "Submit signed receipt" }));
    await user.click(await screen.findByRole("button", { name: "Execute approved request" }));
    expect(await screen.findByRole("heading", { name: "검증된 실행 결과" })).toBeInTheDocument();
    expect(screen.getByText(COMPLETION.commit)).toBeInTheDocument();
    expect(h.executeRequest).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByText(COMPLETION.commit)).toBeInTheDocument(); expect(h.executeRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous staging request from being sent twice and recovers via status read", async () => {
    const h = harness(); h.stage.mockRejectedValueOnce(new TypeError("network lost"));
    const user = await fill(); await user.click(screen.getByRole("button", { name: "검토한 계획 승인 요청" }));
    await screen.findByText(/자동 재전송하지 않습니다/);
    expect(screen.getByRole("button", { name: "검토한 계획 승인 요청" })).toBeDisabled();
    expect(h.stage).toHaveBeenCalledTimes(1);
    h.setData({ ...EMPTY, requests: [PENDING] });
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByLabelText("Signed receipt JSON")).toBeInTheDocument();
    expect(h.stage).toHaveBeenCalledTimes(1);
  });

  it("lets a rejected stale preview be edited and reprepared", async () => {
    const h = harness(); h.stage.mockRejectedValueOnce(new DashboardApiError({ kind: "server",
      code: "TASK_EXECUTION_PREVIEW_STALE", message: "private diagnostic", request_id: "http" }));
    const user = await fill(); await user.click(screen.getByRole("button", { name: "검토한 계획 승인 요청" }));
    expect(await screen.findByText(/검토 후 저장소가 바뀌었습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("파일 경로 1")).toBeEnabled();
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "실행 계획 검토" })).not.toBeInTheDocument();
  });

  it("does not report a disconnected execution as failed or resend it", async () => {
    const approved = { ...EMPTY, requests: [{ ...PENDING, request: { ...PENDING.request, state: "approved" } }] };
    const h = harness(approved); h.executeRequest.mockRejectedValueOnce(new TypeError("disconnect"));
    const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Execute approved request" }));
    await screen.findByText(/서버에서 계속 실행 중일 수 있습니다/);
    expect(screen.getByRole("button", { name: "Execute approved request" })).toBeDisabled();
    h.setData({ ...EMPTY, requests: [{ ...PENDING, request: { ...PENDING.request, state: "completed" }, completion: COMPLETION }] });
    await user.click(screen.getByRole("button", { name: "상태 다시 확인" }));
    expect(await screen.findByText(COMPLETION.commit)).toBeInTheDocument(); expect(h.executeRequest).toHaveBeenCalledTimes(1);
  });

  it("shows local readiness without claiming model authentication or invoking a provider", async () => {
    const h = harness({ ...EMPTY, requests: [PENDING] }); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "실행 환경 확인" }));
    expect(await screen.findByText(/실행 환경이 설정되지 않았습니다/)).toBeInTheDocument();
    expect(h.executeRequest).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous stage across failed reads and task navigation", async () => {
    const h = harness(); const user = await fill();
    h.stage.mockRejectedValueOnce(new TypeError("stage response lost"));
    h.read.mockRejectedValueOnce(new TypeError("read lost"));
    await user.click(screen.getByRole("button", { name: "검토한 계획 승인 요청" }));
    await screen.findByText(/실행 상태를 확인하지 못했습니다/);
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByLabelText("저장소 최상위 경로")).toBeDisabled();
    h.view.rerender(<TaskExecutionPanel taskId="task-other" store={h.store} client={h.client} />);
    h.view.rerender(<TaskExecutionPanel taskId="task-1" store={h.store} client={h.client} />);
    expect(await screen.findByLabelText("저장소 최상위 경로")).toBeDisabled();
    expect(screen.getByText(/전송 이력을 보존 중입니다/)).toHaveTextContent("request-ui");
    expect(h.stage).toHaveBeenCalledTimes(1);
    h.setData({ ...EMPTY, requests: [PENDING] });
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByRole("button", { name: "Submit signed receipt" })).toBeEnabled();
    expect(screen.queryByText(/전송 이력을 보존 중입니다/)).not.toBeInTheDocument();
  });

  it("keeps execution blocked when failed read recovery still observes approved", async () => {
    const approved = { ...EMPTY, requests: [{ ...PENDING, request: { ...PENDING.request, state: "approved" } }] };
    const h = harness(approved); const user = userEvent.setup();
    await screen.findByRole("button", { name: "Execute approved request" });
    h.executeRequest.mockRejectedValueOnce(new TypeError("response lost during preflight"));
    h.read.mockRejectedValueOnce(new TypeError("read lost"));
    await user.click(screen.getByRole("button", { name: "Execute approved request" }));
    await screen.findByText(/실행 상태를 확인하지 못했습니다/);
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByRole("button", { name: "Execute approved request" })).toBeDisabled();
    h.view.rerender(<TaskExecutionPanel taskId="task-other" store={h.store} client={h.client} />);
    h.view.rerender(<TaskExecutionPanel taskId="task-1" store={h.store} client={h.client} />);
    const execute = await screen.findByRole("button", { name: "Execute approved request" });
    expect(execute).toBeDisabled(); await user.click(execute);
    expect(h.executeRequest).toHaveBeenCalledTimes(1);
    h.setData({ ...EMPTY, requests: [{ ...PENDING, request: { ...PENDING.request, state: "completed" }, completion: COMPLETION }] });
    await user.click(screen.getByRole("button", { name: "실행 상태 새로고침" }));
    expect(await screen.findByText(COMPLETION.commit)).toBeInTheDocument();
    expect(screen.queryByText(/전송 이력을 보존 중입니다/)).not.toBeInTheDocument();
  });

  it("disables authority controls during refresh and replaces a failed read with a visible error", async () => {
    const h = harness({ ...EMPTY, requests: [PENDING] }); await screen.findByLabelText("Signed receipt JSON");
    let reject!: (reason: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let pending!: Promise<void>;
    act(() => { pending = h.store.refreshTaskExecution(); });
    expect(screen.getByRole("button", { name: "Submit signed receipt" })).toBeDisabled();
    await act(async () => { reject(new Error("failed")); await pending; });
    await waitFor(() => expect(screen.queryByLabelText("Signed receipt JSON")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("실행 상태를 확인하지 못했습니다");
  });
});
