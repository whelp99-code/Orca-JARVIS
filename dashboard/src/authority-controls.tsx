import { useState, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import type { CommandApprovalReceipt, StoredControlCommand } from "../../src/control-plane.js";
import "./authority-controls.css";
import type { OverviewApproval } from "../../src/dashboard/read-model.js";
import { DashboardApiError } from "./api.js";
import { taskExecutionMessage } from "./task-execution-message.js";
import {
  SYSTEM_AUTHORITY_ID_FACTORY,
  type AuthorityIdFactory,
  type AuthorityMutationClient,
} from "./authority-api.js";

export type AuthorityControlsProps = Readonly<{
  request: OverviewApproval;
  client: Pick<AuthorityMutationClient, "decideRequest" | "executeRequest" | "retryRequest">;
  idFactory?: AuthorityIdFactory;
  enabled?: boolean;
  onRefresh?: () => Promise<void>;
  taskExecutionContext?: boolean;
}>;

type Action = "decision" | "execution" | "retry";
type Operation =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly action: Action }
  | { readonly kind: "error"; readonly action: "receipt" | Action; readonly message?: string }
  | { readonly kind: "unknown_execution" }
  | { readonly kind: "decided"; readonly state: "approved" | "rejected" }
  | { readonly kind: "executed"; readonly state: "completed" | "failed" | "uncertain" }
  | { readonly kind: "retried"; readonly command: StoredControlCommand }
  | { readonly kind: "replan_required" };
type ReceiptParse =
  | { readonly ok: true; readonly receipt: CommandApprovalReceipt }
  | { readonly ok: false };

const RECEIPT_KEYS = [
  "schema_version", "receipt_id", "request_id", "decision", "command_digest",
  "signer_principal_id", "authenticated_session_id", "key_id", "algorithm",
  "issued_at", "not_before", "expires_at", "nonce", "max_uses", "status", "signature",
] as const;

export function AuthorityControls({
  request,
  client,
  idFactory = SYSTEM_AUTHORITY_ID_FACTORY,
  enabled = true,
  onRefresh,
  taskExecutionContext = false,
}: AuthorityControlsProps) {
  const [receiptJson, setReceiptJson] = useState("");
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const busy = operation.kind === "loading" || operation.kind === "unknown_execution" || !enabled;
  const taskDetailRequired = request.action === "task.execute" && !taskExecutionContext;

  async function decide(): Promise<void> {
    const parsed = parseReceiptJson(receiptJson);
    if (!parsed.ok) {
      setOperation({ kind: "error", action: "receipt" });
      return;
    }
    setOperation({ kind: "loading", action: "decision" });
    try {
      const result = await client.decideRequest(request.request_id, {
        schema_version: 1,
        receipt: parsed.receipt,
      });
      setReceiptJson("");
      setOperation({ kind: "decided", state: result.state });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setOperation({ kind: "error", action: "decision" });
    }
  }

  async function execute(): Promise<void> {
    if (busy || taskDetailRequired) return;
    setOperation({ kind: "loading", action: "execution" });
    try {
      const result = await client.executeRequest(request.request_id);
      setOperation({ kind: "executed", state: result.execution.state });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      const task = request.action === "task.execute";
      const unknown = !(error instanceof DashboardApiError) || error.kind === "offline"
        || ["VALIDATION_ERROR", "INTERNAL_ERROR"].includes(error.code);
      setOperation(task && unknown ? { kind: "unknown_execution" }
        : { kind: "error", action: "execution", ...(task ? { message: taskExecutionMessage(error) } : {}) });
    }
  }

  async function retry(): Promise<void> {
    setOperation({ kind: "loading", action: "retry" });
    try {
      const command = await client.retryRequest(request.request_id, {
        schema_version: 1,
        request_id: idFactory("request_id"),
        nonce: idFactory("nonce"),
      });
      setOperation({ kind: "retried", command });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setOperation(error instanceof DashboardApiError && error.code === "RETRY_REPLAN_REQUIRED"
        ? { kind: "replan_required" } : { kind: "error", action: "retry" });
    }
  }

  function submitReceipt(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    void decide();
  }

  const decisionComplete = operation.kind === "decided";
  const executionComplete = operation.kind === "executed";
  const retryComplete = operation.kind === "retried";
  const replanRequired = request.retry_status === "replan_required" || operation.kind === "replan_required";

  return (
    <article className="authority-controls">
      <dl className="identity-list" aria-label="Request evidence">
        <div><dt>요청</dt><dd>{request.request_id}</dd></div>
        <div><dt>할 일</dt><dd>{request.action}</dd></div>
        <div><dt>단계</dt><dd>{request.action_level}단계</dd></div>
        <div><dt>상태</dt><dd>{request.state}</dd></div>
      </dl>
      {taskDetailRequired ? <p>파일·검사·전송 상태를 확인하고 작업 상세에서 승인·실행하세요. <Link
        to={request.task_id ? `/tasks/${encodeURIComponent(request.task_id)}` : "/tasks"}>작업 실행 상세 열기</Link></p> : null}
      {request.state === "pending" && !decisionComplete && !taskDetailRequired ? (
        <form className="control-form" onSubmit={submitReceipt}>
          <label className="form-field">
            <span>서명 영수증</span>
            <textarea
              required
              disabled={!enabled}
              value={receiptJson}
              onChange={(event) => { setReceiptJson(event.target.value); }}
            />
          </label>
          <button type="submit" disabled={busy}>서명 제출</button>
        </form>
      ) : null}
      {request.state === "approved" && !executionComplete && !taskDetailRequired ? (
        <button type="button" disabled={busy} onClick={() => { void execute(); }}>
          승인된 요청 실행
        </button>
      ) : null}
      {request.state === "failed" && request.action !== "task.execute" && !retryComplete && !replanRequired && request.retry_status !== "not_allowed" ? (
        <button type="button" disabled={busy} onClick={() => { void retry(); }}>
          실패한 요청 다시 시도
        </button>
      ) : null}
      {request.state === "failed" && replanRequired ? (
        <div role="status">
          <p>작업 명세와 실행 기한을 다시 정하고 새 승인을 받아주세요.</p>
          <a href="/proposals">새 작업 제안</a>
        </div>
      ) : null}
      <OperationMessage operation={operation} />
      {operation.kind === "unknown_execution" && onRefresh ? <button type="button" onClick={() => { void onRefresh(); }}>
        상태 다시 확인
      </button> : null}
      {operation.kind === "retried" ? <PendingRequest command={operation.command} /> : null}
    </article>
  );
}

function OperationMessage({ operation }: Readonly<{ operation: Operation }>) {
  switch (operation.kind) {
    case "idle":
    case "retried":
    case "replan_required":
      return null;
    case "loading":
      return <p className="control-status" role="status">Submitting request</p>;
    case "unknown_execution":
      return <p className="control-error" role="alert">실행 응답을 확인하지 못했습니다. 서버에서 계속 실행 중일 수 있습니다.
        상태를 다시 조회하세요. 실행을 자동 재전송하지 않습니다.</p>;
    case "error": {
      if (operation.message) return <p className="control-error" role="alert">{operation.message}</p>;
      const action = operation.action;
      switch (action) {
        case "receipt":
          return <p className="control-error" role="alert">서명 영수증은 올바른 JSON이어야 합니다</p>;
        case "decision":
          return <p className="control-error" role="alert">Unable to submit signed receipt</p>;
        case "execution":
          return <p className="control-error" role="alert">Unable to execute approved request</p>;
        case "retry":
          return <p className="control-error" role="alert">Unable to retry failed request</p>;
        default:
          return assertNever(action);
      }
    }
    case "decided":
      return <p className="control-status" role="status">Request {operation.state}</p>;
    case "executed":
      return operation.state === "completed" ? (
        <p className="control-status" role="status">Execution completed</p>
      ) : (
        <p className="control-error" role="alert">Execution {operation.state}</p>
      );
    default:
      return assertNever(operation);
  }
}

function PendingRequest({ command }: Readonly<{ command: StoredControlCommand }>) {
  return (
    <section className="staged-request" aria-label="Pending request">
      <h3>Pending request</h3>
      <dl className="identity-list">
        <div><dt>Request</dt><dd>{command.request_id}</dd></div>
        <div><dt>Action</dt><dd>{command.action}</dd></div>
        <div><dt>단계</dt><dd>{command.action_level}단계</dd></div>
        <div><dt>State</dt><dd>{command.state}</dd></div>
      </dl>
    </section>
  );
}

function parseReceiptJson(value: string): ReceiptParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { ok: false };
    throw error;
  }
  return isReceipt(parsed) ? { ok: true, receipt: parsed } : { ok: false };
}

function isReceipt(value: unknown): value is CommandApprovalReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false;
  return value.schema_version === 1 && typeof value.receipt_id === "string"
    && typeof value.request_id === "string" && (value.decision === "approve" || value.decision === "reject")
    && typeof value.command_digest === "string" && typeof value.signer_principal_id === "string"
    && typeof value.authenticated_session_id === "string" && typeof value.key_id === "string"
    && value.algorithm === "Ed25519" && typeof value.issued_at === "string"
    && typeof value.not_before === "string" && typeof value.expires_at === "string"
    && typeof value.nonce === "string" && value.max_uses === 1 && value.status === "issued"
    && typeof value.signature === "string";
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isMutationError(error: unknown): error is DashboardApiError | TypeError | DOMException {
  return error instanceof DashboardApiError || error instanceof TypeError || error instanceof DOMException;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected authority state: ${JSON.stringify(value)}`);
}
