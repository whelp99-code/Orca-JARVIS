import { useState, type SyntheticEvent } from "react";
import type { PreparedDashboardTaskExecution } from "../../src/dashboard/task-execution-service.js";
import type { AuthorityIdFactory, TaskExecutionClient } from "./authority-api.js";
import { SYSTEM_AUTHORITY_ID_FACTORY } from "./authority-api.js";
import { isTaskExecutionRejection, taskExecutionMessage } from "./task-execution-message.js";
import { TaskExecutionPlanView } from "./task-execution-plan-view.js";
import type { TaskTemplateBinding } from "../../src/task-templates.js";
import { TaskTemplateSummary } from "./task-template-summary.js";
import { TaskRoutingSummary } from "./task-routing-summary.js";
import type { DashboardTaskRouting } from "../../src/dashboard/task-routing-read.js";

type FileInput = { id: number; path: string; access: "read" | "write"; exists: boolean };
type CheckInput = { id: number; executable: string; args: string; cwd: string };
export function TaskExecutionForm({ taskId, runs, client, refresh, enabled, templates, routing, idFactory = SYSTEM_AUTHORITY_ID_FACTORY }: Readonly<{
  taskId: string; runs: readonly string[]; client: TaskExecutionClient; refresh: () => Promise<void>;
  enabled: boolean; idFactory?: AuthorityIdFactory;
  templates?: Readonly<Record<string, TaskTemplateBinding>>;
  routing?: Readonly<Record<string, DashboardTaskRouting>>;
}>) {
  const [run, setRun] = useState(runs.length === 1 ? runs[0]! : "");
  const [root, setRoot] = useState(""); const [branch, setBranch] = useState("");
  const [seconds, setSeconds] = useState(180);
  const [files, setFiles] = useState<FileInput[]>([{ id: 1, path: "", access: "write", exists: true }]);
  const [checks, setChecks] = useState<CheckInput[]>([{ id: 1, executable: "node", args: "", cwd: "." }]);
  const [preview, setPreview] = useState<PreparedDashboardTaskExecution>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState<string>();
  const [existing, setExisting] = useState<readonly string[]>([]);
  const template = templates?.[run];
  const selection = routing?.[run];
  const supportedSelection = !selection || selection.executor_id === "claude-code";
  const available = enabled && runs.includes(run) && !busy && !submitted && supportedSelection;

  function edit(change: () => void) { change(); setPreview(undefined); setError(""); }
  async function prepare(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault(); if (!available) return;
    setBusy(true); setError(""); setPreview(undefined);
    try {
      const selectedFiles = template ? template.files.map(file => ({ ...file,
        exists: file.access === "read" || existing.includes(file.path) })) : files;
      setPreview(await client.prepare(taskId, { schema_version: 1, run_id: run, provider: "claude", repository_root: root,
        publication_ref: `refs/heads/codex/${branch}`, files: selectedFiles.map(({ path, access, exists }) => ({ path, access, exists })),
        limits: { timeout_ms: seconds * 1000, max_output_bytes: 262144 },
        verification: template?.verification ?? checks.map(check => ({ id: `check-${check.id}`, argv: [check.executable,
          ...check.args.split(/\r?\n/).filter(line => line.length > 0)], cwd: check.cwd, expected_exit: 0 })) }));
    } catch (caught) { setError(taskExecutionMessage(caught)); }
    finally { setBusy(false); }
  }
  async function stage() {
    if (!available || !preview) return;
    setBusy(true); setError("");
    const requestId = idFactory("request_id"); setSubmitted(requestId);
    try {
      await client.stage(taskId, { schema_version: 1, request_id: requestId, nonce: idFactory("nonce"), plan: preview.plan });
      setPreview(undefined);
    } catch (caught) {
      setError(taskExecutionMessage(caught));
      if (isTaskExecutionRejection(caught)) { setSubmitted(undefined); setPreview(undefined); }
    } finally { setBusy(false); await refresh(); }
  }
  return <section aria-label="실행 계획 준비" className="execution-form-section">
    <h3>실행 계획 준비</h3>
    {selection ? <TaskRoutingSummary routing={selection} /> : null}
    {!supportedSelection ? <p role="alert">선택된 실행자는 이 화면에서 실행 계획을 준비할 수 없습니다.</p> : null}
    <p>커밋된 파일에서 작업을 시작합니다. 수정할 파일과 검사에 필요한 읽기 파일을 함께 선택하세요.</p>
    <form className="control-form" onSubmit={event => { void prepare(event); }}>
      <fieldset disabled={busy || !enabled || !!submitted}>
        <label className="form-field"><span>작업 실행 흐름</span><select value={run} required onChange={event => edit(() => {
          setRun(event.target.value); setExisting([]);
        })}>
          <option value="">작업 선택</option>{runs.map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <label className="form-field"><span>저장소 최상위 경로</span><input value={root} required placeholder="/home/.../project"
          onChange={event => edit(() => setRoot(event.target.value))} /></label>
        <label className="form-field"><span>새 결과 브랜치 이름</span><input value={branch} required placeholder="task-result"
          pattern="[a-z0-9][a-z0-9._\-]{0,79}" onChange={event => edit(() => setBranch(event.target.value))} /></label>
        <p className="muted">브랜치는 codex/ 아래에 생성됩니다. 실행 에이전트: Claude.</p>
        <label className="form-field"><span>실행 시간 제한(초)</span><input type="number" min={1} max={600} step={1}
          value={seconds} required onChange={event => edit(() => setSeconds(Number(event.target.value)))} /></label>
        {template ? <><TaskTemplateSummary template={template} />
          <p>아래 결과 파일이 이미 커밋되어 있으면 표시하세요. 경로와 필수 검사를 바꾸려면 새 업무 승인이 필요합니다.</p>
          {template.files.filter(file => file.access === "write").map(file => <label key={file.path}>
            <input type="checkbox" checked={existing.includes(file.path)} onChange={event => edit(() => setExisting(current =>
              event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path)))} />
            {file.path} — 기존 파일 수정
          </label>)}</> : <><h4>파일</h4>
        {files.map((file, index) => <div className="execution-file-input" key={file.id}>
          <label className="form-field"><span>파일 경로 {index + 1}</span><input required value={file.path}
            onChange={event => edit(() => setFiles(files.map(item => item.id === file.id ? { ...item, path: event.target.value } : item)))} /></label>
          <label className="form-field"><span>파일 용도 {index + 1}</span><select value={!file.exists ? "new" : file.access}
            onChange={event => edit(() => setFiles(files.map(item => item.id === file.id
              ? { ...item, access: event.target.value === "read" ? "read" : "write", exists: event.target.value !== "new" } : item)))}>
            <option value="write">기존 파일 수정</option><option value="read">읽기 전용</option><option value="new">새 파일</option>
          </select></label>
          <button type="button" disabled={files.length === 1} onClick={() => edit(() => setFiles(files.filter(item => item.id !== file.id)))}
            aria-label={`파일 ${index + 1} 제거`}>제거</button>
        </div>)}
        <button type="button" disabled={files.length >= 128} onClick={() => edit(() => setFiles([...files,
          { id: Math.max(...files.map(file => file.id)) + 1, path: "", access: "read", exists: true }]))}>파일 추가</button>
        <h4>완료 검사</h4><p>선택한 파일로 격리 실행합니다. 인수는 한 줄에 하나씩 입력하세요.</p>
        {checks.map((check, index) => <fieldset key={check.id} className="execution-check-input"><legend>검사 {index + 1}</legend>
          <label className="form-field"><span>실행 파일 {index + 1}</span><input required value={check.executable}
            onChange={event => edit(() => setChecks(checks.map(item => item.id === check.id ? { ...item, executable: event.target.value } : item)))} /></label>
          <label className="form-field"><span>검사 인수 {index + 1}</span><textarea value={check.args}
            onChange={event => edit(() => setChecks(checks.map(item => item.id === check.id ? { ...item, args: event.target.value } : item)))} /></label>
          <label className="form-field"><span>검사 위치 {index + 1}</span><input required value={check.cwd}
            onChange={event => edit(() => setChecks(checks.map(item => item.id === check.id ? { ...item, cwd: event.target.value } : item)))} /></label>
          <button type="button" disabled={checks.length === 1} onClick={() => edit(() => setChecks(checks.filter(item => item.id !== check.id)))}>검사 {index + 1} 제거</button>
        </fieldset>)}
        <button type="button" disabled={checks.length >= 8} onClick={() => edit(() => setChecks([...checks,
          { id: Math.max(...checks.map(check => check.id)) + 1, executable: "node", args: "", cwd: "." }]))}>검사 추가</button></>}
      </fieldset>
      <button type="submit" disabled={!available}>계획 준비</button>
    </form>
    {busy ? <p role="status">계획과 저장소를 확인하는 중입니다.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <section aria-label="실행 계획 검토"><h3>실행 계획 검토</h3><TaskExecutionPlanView plan={preview.plan} />
      <p>선택 파일 합계 {preview.repository.total_bytes}바이트</p>
      <button type="button" disabled={!available} onClick={() => { void stage(); }}>검토한 계획 승인 요청</button>
    </section> : null}
    {submitted ? <p role="status">요청 {submitted}의 접수 상태를 아래 실행 요청 목록에서 확인하세요.
      응답이 없으면 상태를 다시 조회하세요. 같은 계획을 자동 재전송하지 않습니다.</p> : null}
  </section>;
}
