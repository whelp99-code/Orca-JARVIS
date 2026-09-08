import { useRef, useState, type SyntheticEvent } from "react";
import type { ProposalMutationClient } from "./api-mutations.js";
import type { IdFactory } from "./proposal-page.js";
import { ProposalPreviewPane, type PreviewState, type StageState } from "./proposal-result.js";
import { TEMPLATE_LABELS, type CompiledTaskTemplate } from "./task-template-contract.js";
import { TaskTemplateSummary } from "./task-template-summary.js";
import { taskExecutionMessage } from "./task-execution-message.js";
import "./task-execution.css";

const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function TaskTemplateProposal({ client, clock, idFactory, onBack }: {
  client: ProposalMutationClient; clock: () => Date; idFactory: IdFactory; onBack: () => void;
}) {
  const [template, setTemplate] = useState("technical-review");
  const [objective, setObjective] = useState("");
  const [sources, setSources] = useState(""); const [outputs, setOutputs] = useState("report.json");
  const [executable, setExecutable] = useState("node"); const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("."); const [compiled, setCompiled] = useState<CompiledTaskTemplate>();
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [stage, setStage] = useState<StageState>({ kind: "idle" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(""); const pending = useRef(false);
  const code = template === "code-fix";
  function edit(action: () => void) { action(); setCompiled(undefined); setPreview({ kind: "idle" }); setError(""); }
  async function prepare(event?: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event?.preventDefault(); if (pending.current || submitted || !client.compileTemplate) return;
    pending.current = true; setBusy(true); setError(""); setCompiled(undefined); setPreview({ kind: "idle" });
    try {
      const value = await client.compileTemplate({ template_id: template, revision: 1, objective: objective.trim(),
        files: [...lines(sources).map(path => ({ path, access: "read" })), ...lines(outputs).map(path => ({ path, access: "write" }))],
        verification: code ? [{ id: "template-code-check", argv: [executable, ...args.split(/\r?\n/).filter(Boolean)],
          cwd, expected_exit: 0 }] : [] });
      const result = await client.previewProposal(value.proposal_request);
      setCompiled(value); setPreview({ kind: "complete", request: value.proposal_request, result });
    } catch (caught) { setError(taskExecutionMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function stageTask() {
    if (pending.current || submitted || !compiled || preview.kind !== "complete" || preview.result.status !== "ready") return;
    const digest = preview.result.proposal_digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) { setError("제안 식별 정보를 확인하지 못했습니다."); return; }
    const task = { schema_version: 1 as const, request_id: idFactory("request_id"), nonce: idFactory("nonce"),
      task_id: idFactory("task_id"), run_id: idFactory("run_id"), expected_proposal_digest: digest as `sha256:${string}`,
      ...compiled, budget: { max_steps: 10, max_attempts_per_node: 3,
        deadline: new Date(clock().getTime() + 6 * 60 * 60 * 1000).toISOString() } };
    pending.current = true; setBusy(true); setSubmitted(task.request_id); setStage({ kind: "loading" });
    try { setStage({ kind: "success", command: await client.createTask(task), task }); }
    catch (caught) { setError(taskExecutionMessage(caught)); setStage({ kind: "error" }); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="page-frame dashboard-main proposal-page">
    <header className="proposal-heading"><h1>템플릿으로 업무 시작</h1>
      <p>작업 범위와 완료 검사를 정한 뒤 승인을 요청합니다.</p>
      <button type="button" disabled={busy} onClick={onBack}>일반 업무 제안으로 돌아가기</button></header>
    <div className="proposal-layout">
      <form className="panel proposal-form" onSubmit={event => { void prepare(event); }}>
        <div className="proposal-form-body"><fieldset disabled={busy || !!submitted} className="template-fields">
          <label className="form-field"><span>업무 템플릿</span><select value={template} onChange={event => edit(() => {
            setTemplate(event.target.value); setOutputs(event.target.value === "code-fix" ? "" : "report.json");
          })}>{Object.entries(TEMPLATE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="form-field"><span>업무 목표</span><textarea required value={objective}
            onChange={event => edit(() => setObjective(event.target.value))} /></label>
          <label className="form-field"><span>읽기 전용 원본 파일</span><textarea required={!code} value={sources}
            placeholder="src/example.ts" onChange={event => edit(() => setSources(event.target.value))} /></label>
          <p>저장소 기준 상대 경로를 한 줄에 하나씩 입력하세요. 검사에 필요한 파일도 포함하세요.</p>
          <label className="form-field"><span>{code ? "수정할 파일" : "보고서 결과 파일"}</span><textarea required value={outputs}
            onChange={event => edit(() => setOutputs(event.target.value))} /></label>
          {code ? <><h3>필수 완료 검사</h3>
            <label className="form-field"><span>검사 실행 파일</span><input required value={executable}
              onChange={event => edit(() => setExecutable(event.target.value))} /></label>
            <label className="form-field"><span>검사 인수 — 한 줄에 하나</span><textarea value={args}
              onChange={event => edit(() => setArgs(event.target.value))} /></label>
            <label className="form-field"><span>검사 작업 위치</span><input required value={cwd}
              onChange={event => edit(() => setCwd(event.target.value))} /></label></>
            : <p>출력 파일은 하나만 허용하며, 보고서 구조와 원문 인용 검사가 자동으로 포함됩니다.</p>}
          <button type="submit" disabled={!client.compileTemplate}>{busy ? "범위 확인 중" : "템플릿 제안 미리보기"}</button>
        </fieldset></div>
      </form>
      <div>{error ? <p role="alert">{error}</p> : null}
        {compiled ? <TaskTemplateSummary template={compiled.task_template} /> : null}
        <ProposalPreviewPane preview={preview} stage={stage} stageLocked={!!submitted}
          onRetry={() => { void prepare(); }} onStage={() => { void stageTask(); }} />
        {submitted ? <p role="status">요청 {submitted}을 전송했습니다. 응답이 불확실하면 승인 목록에서 이 식별자를 확인하세요.
          같은 요청을 자동으로 다시 보내지 않습니다.</p> : null}
        {stage.kind === "success" ? <p>
          <a href="/approvals">시작 요청 승인하기</a>{" · "}
          <a href={`/tasks/${encodeURIComponent(stage.task.task_id)}`}>작업 상세 보기</a>
        </p> : null}
      </div>
    </div>
  </div>;
}
