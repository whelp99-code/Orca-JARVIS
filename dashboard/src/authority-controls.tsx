import { useState, type SyntheticEvent } from "react";
import type { CommandApprovalReceipt, StoredControlCommand } from "../../src/control-plane.js";
import "./authority-controls.css";
import type { OverviewApproval } from "../../src/dashboard/read-model.js";
import { DashboardApiError } from "./api.js";
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
}>;

type Action = "decision" | "execution" | "retry";
type Operation =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly action: Action }
  | { readonly kind: "error"; readonly action: "receipt" | Action }
  | { readonly kind: "decided"; readonly state: "approved" | "rejected" }
  | { readonly kind: "executed"; readonly state: "completed" | "failed" | "uncertain" }
  | { readonly kind: "retried"; readonly command: StoredControlCommand };
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
}: AuthorityControlsProps) {
  const [receiptJson, setReceiptJson] = useState("");
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const busy = operation.kind === "loading" || !enabled;

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
    setOperation({ kind: "loading", action: "execution" });
    try {
      const result = await client.executeRequest(request.request_id);
      setOperation({ kind: "executed", state: result.execution.state });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setOperation({ kind: "error", action: "execution" });
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
      setOperation({ kind: "error", action: "retry" });
    }
  }

  function submitReceipt(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    void decide();
  }

  const decisionComplete = operation.kind === "decided";
  const executionComplete = operation.kind === "executed";
  const retryComplete = operation.kind === "retried";

  return (
    <article className="authority-controls">
      <dl className="identity-list" aria-label="Request evidence">
        <div><dt>Request</dt><dd>{request.request_id}</dd></div>
        <div><dt>Action</dt><dd>{request.action}</dd></div>
        <div><dt>Level</dt><dd>Level {request.action_level}</dd></div>
        <div><dt>State</dt><dd>{request.state}</dd></div>
      </dl>
      {request.state === "pending" && !decisionComplete ? (
        <form className="control-form" onSubmit={submitReceipt}>
          <label className="form-field">
            <span>Signed receipt JSON</span>
            <textarea
              required
              disabled={!enabled}
              value={receiptJson}
              onChange={(event) => { setReceiptJson(event.target.value); }}
            />
          </label>
          <button type="submit" disabled={busy}>Submit signed receipt</button>
        </form>
      ) : null}
      {request.state === "approved" && !executionComplete ? (
        <button type="button" disabled={busy} onClick={() => { void execute(); }}>
          Execute approved request
        </button>
      ) : null}
      {request.state === "failed" && !retryComplete ? (
        <button type="button" disabled={busy} onClick={() => { void retry(); }}>
          Retry failed request
        </button>
      ) : null}
      <OperationMessage operation={operation} />
      {operation.kind === "retried" ? <PendingRequest command={operation.command} /> : null}
    </article>
  );
}

function OperationMessage({ operation }: Readonly<{ operation: Operation }>) {
  switch (operation.kind) {
    case "idle":
    case "retried":
      return null;
    case "loading":
      return <p className="control-status" role="status">Submitting request</p>;
    case "error": {
      const action = operation.action;
      switch (action) {
        case "receipt":
          return <p className="control-error" role="alert">Signed receipt must be valid JSON</p>;
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
        <div><dt>Level</dt><dd>Level {command.action_level}</dd></div>
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
