import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProposalPage } from "./proposal-page.js";
import { TaskExecutionForm } from "./task-execution-form.js";
import { TaskTemplateSummary } from "./task-template-summary.js";
import type { CompiledTaskTemplate } from "./task-template-contract.js";
import { HASH, PREVIEW } from "./task-execution-test-fixture.js";
import type { ProposalMutationClient } from "./api-mutations.js";
import type { TaskExecutionClient } from "./authority-api.js";

afterEach(cleanup);
const compiled: CompiledTaskTemplate = {
  task_template: { schema_version: 1, template_id: "technical-review", revision: 1, definition_digest: HASH,
    files: [{ path: "answer.mjs", access: "read" }, { path: "report.json", access: "write" }],
    verification: [{ id: "template-report-v1", argv: ["node", "-e", "fixture checker", "--", "report.json"], cwd: ".", expected_exit: 0 }] },
  proposal_request: { schema_version: 1, objective: "Review answer", work_type: "analysis", constraints: ["Keep sources read-only"],
    completion_evidence: ["Report shape and quotations checked"] },
};

it("previews server-compiled scope, invalidates edits, and preserves a single request after an uncertain response", async () => {
  const user = userEvent.setup();
  const compileTemplate = vi.fn(async () => structuredClone(compiled));
  const previewProposal = vi.fn(async () => ({ schema_version: 1 as const, status: "ready" as const,
    objective: "Review answer", proposal_digest: HASH, members: [],
    requirements: { work_type: "analysis" as const, constraints: ["Keep sources read-only"], completion_evidence: ["Report checked"] } }));
  const createTask = vi.fn<ProposalMutationClient["createTask"]>(async () => { throw new DOMException("timeout", "TimeoutError"); });
  render(<ProposalPage client={{ compileTemplate, previewProposal, createTask }}
    idFactory={kind => `template-${kind}`} clock={() => new Date("2026-09-09T00:00:00.000Z")} />);
  await user.click(screen.getByRole("button", { name: "템플릿으로 시작" }));
  await user.type(screen.getByLabelText("업무 목표"), "Review answer");
  await user.type(screen.getByLabelText("읽기 전용 원본 파일"), "answer.mjs");
  await user.click(screen.getByRole("button", { name: "템플릿 제안 미리보기" }));
  await screen.findByRole("region", { name: "템플릿 범위" });
  expect(compileTemplate).toHaveBeenCalledWith({ template_id: "technical-review", revision: 1, objective: "Review answer",
    files: compiled.task_template.files, verification: [] });
  expect(previewProposal).toHaveBeenCalledWith(compiled.proposal_request);
  await user.type(screen.getByLabelText("업무 목표"), " again");
  expect(screen.queryByRole("region", { name: "템플릿 범위" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "템플릿 제안 미리보기" }));
  const stage = await screen.findByRole("button", { name: "Stage task" });
  await user.click(stage); await screen.findAllByRole("alert");
  await user.click(stage);
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(stage).toBeDisabled();
  expect(createTask.mock.calls[0]?.[0]).toMatchObject({ task_template: compiled.task_template,
    proposal_request: compiled.proposal_request, request_id: "template-request_id", expected_proposal_digest: HASH });
  expect(screen.getByLabelText("업무 목표")).toBeDisabled();
});

it("loads approved files and mandatory checks in preparation without editable scope fields", async () => {
  const user = userEvent.setup(); const prepare = vi.fn<TaskExecutionClient["prepare"]>(async () => PREVIEW);
  render(<TaskExecutionForm taskId="task-1" runs={["run-1"]} templates={{ "run-1": compiled.task_template }} enabled
    refresh={async () => {}} client={{ read: vi.fn(), check: vi.fn(), stage: vi.fn(), prepare }} />);
  expect(screen.queryByLabelText("파일 경로 1")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("검사 인수 1")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("저장소 최상위 경로"), "/repo");
  await user.type(screen.getByLabelText("새 결과 브랜치 이름"), "review");
  await user.click(screen.getByRole("button", { name: "계획 준비" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  expect(prepare.mock.calls[0]?.[1]).toMatchObject({ files: [
    { path: "answer.mjs", access: "read", exists: true }, { path: "report.json", access: "write", exists: false }],
  verification: compiled.task_template.verification });
});

it("labels report completion as structure/quotation evidence and retains code-check command visibility", () => {
  const view = render(<TaskTemplateSummary template={compiled.task_template} />);
  expect(screen.getByText(/진단·권고의 정확성은 검토가 필요/)).toBeInTheDocument();
  expect(screen.getByText("보고서 필수 항목과 원본 인용 확인")).toBeInTheDocument();
  view.rerender(<TaskTemplateSummary template={{ ...compiled.task_template, template_id: "code-fix" }} />);
  expect(screen.getByText(/fixture checker/)).toBeInTheDocument();
});

it("clears existing-output selection when switching approved workflows", async () => {
  const user = userEvent.setup();
  render(<TaskExecutionForm taskId="task-1" runs={["run-1", "run-2"]}
    templates={{ "run-1": compiled.task_template, "run-2": compiled.task_template }} enabled
    refresh={async () => {}} client={{ read: vi.fn(), check: vi.fn(), stage: vi.fn(), prepare: vi.fn() }} />);
  await user.selectOptions(screen.getByLabelText("작업 실행 흐름"), "run-1");
  await user.click(screen.getByRole("checkbox", { name: "report.json — 기존 파일 수정" }));
  expect(screen.getByRole("checkbox")).toBeChecked();
  await user.selectOptions(screen.getByLabelText("작업 실행 흐름"), "run-2");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});
