import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskExecutionClient } from "./authority-api.js";
import { TaskExecutionForm } from "./task-execution-form.js";
import type { DashboardTaskRouting } from "../../src/dashboard/task-routing-read.js";
import { TaskRoutingSummary } from "./task-routing-summary.js";
import { parseTaskExecution } from "./task-execution-guard.js";
import { EMPTY, HASH, PENDING } from "./task-execution-test-fixture.js";

afterEach(cleanup);
const routing: DashboardTaskRouting = { schema_version: 1, executor_id: "claude-code", policy_id: "task-selection",
  policy_revision: 1, policy_digest: HASH, decision_digest: HASH, task_spec_digest: HASH, rule_id: "code",
  proposed_record_stores: ["second-brain"], authority: "display_only", delivery: "not_attested" };
const response = () => ({ ...EMPTY, runs: [{ ...EMPTY.runs[0]!, routing }], requests: [{ ...PENDING, routing }] });

it("shows the executor and proposed destination with inspectable binding identifiers", async () => {
  render(<TaskRoutingSummary routing={routing} />);
  expect(screen.getByRole("region", { name: "작업별 실행자 선택" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "선택된 실행자: Claude Code" })).toBeVisible();
  expect(screen.getByText("기록 위치 제안: second-brain")).toBeVisible();
  expect(screen.getByText(/기록 전달 완료를 뜻하지 않습니다/)).toBeVisible();
  await userEvent.click(screen.getByText("라우팅 식별 정보"));
  expect(screen.getByText("작업 명세 해시")).toBeVisible();
});

it("accepts legacy and bound responses but rejects authority, delivery and binding changes", () => {
  expect(parseTaskExecution(EMPTY, EMPTY.task_id)).toEqual(EMPTY);
  expect(parseTaskExecution(response(), EMPTY.task_id)).toEqual(response());
  for (const change of [{ authority: "approved" }, { delivery: "delivered" }, { policy: {} },
    { proposed_record_stores: ["second-brain", "second-brain"] }, { decision_digest: "invalid" },
    { task_spec_digest: `sha256:${"b".repeat(64)}` }]) {
    const value = response();
    value.requests[0]!.routing = { ...routing, ...change } as DashboardTaskRouting;
    expect(parseTaskExecution(value, EMPTY.task_id)).toBeUndefined();
  }
  const value = response();
  value.requests[0]!.plan = { ...PENDING.plan, provider: "codex" };
  expect(parseTaskExecution(value, EMPTY.task_id)).toBeUndefined();
});

it("switches selection summaries and prevents preparing an unsupported executor", async () => {
  const prepare = vi.fn<TaskExecutionClient["prepare"]>();
  const client: TaskExecutionClient = { prepare, read: vi.fn(), stage: vi.fn(), check: vi.fn() };
  const { container } = render(<TaskExecutionForm taskId="task-1" runs={["run-1", "run-2"]}
    client={client} refresh={vi.fn()} enabled routing={{ "run-1": routing,
      "run-2": { ...routing, executor_id: "codex", policy_id: "another-selection" } }} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("작업 실행 흐름"), "run-2");
  expect(screen.getByRole("heading", { name: "선택된 실행자: codex" })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("실행 계획을 준비할 수 없습니다");
  expect(screen.getByRole("button", { name: "계획 준비" })).toBeDisabled();
  fireEvent.submit(container.querySelector("form")!);
  expect(prepare).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText("작업 실행 흐름"), "run-1");
  expect(screen.getByRole("heading", { name: "선택된 실행자: Claude Code" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "계획 준비" })).toBeEnabled();
});
