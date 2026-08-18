import { useState, type SyntheticEvent } from "react";
import type { StoredControlCommand } from "../../src/control-plane.js";
import type { TaskDetailEvent, TaskDetailResponse } from "../../src/dashboard/read-model.js";
import { DashboardApiError } from "./api.js";
import "./authority-controls.css";
import {
  SYSTEM_AUTHORITY_ID_FACTORY,
  type AuthorityIdFactory,
  type AuthorityMutationClient,
} from "./authority-api.js";

export type TaskControlProps = Readonly<{
  detail: TaskDetailResponse;
  client: Pick<AuthorityMutationClient, "cancelTask">;
  idFactory?: AuthorityIdFactory;
}>;

type StageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "success"; readonly command: StoredControlCommand };

const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "uncertain", "cancelled"]);
const ID_LIMIT = 128;

export function TaskControl({
  detail,
  client,
  idFactory = SYSTEM_AUTHORITY_ID_FACTORY,
}: TaskControlProps) {
  const [reason, setReason] = useState("");
  const [stage, setStage] = useState<StageState>({ kind: "idle" });
  const { task, events } = detail.context;
  const runId = cancelRunId(task.state, task.source_ids, events);
  if (runId === undefined) return null;
  const availableRunId = runId;

  async function cancel(): Promise<void> {
    setStage({ kind: "loading" });
    try {
      const command = await client.cancelTask(task.task_id, {
        schema_version: 1,
        request_id: idFactory("request_id"),
        nonce: idFactory("nonce"),
        run_id: availableRunId,
        reason,
      });
      setReason("");
      setStage({ kind: "success", command });
    } catch (error: unknown) {
      if (!isMutationError(error)) throw error;
      setStage({ kind: "error" });
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    void cancel();
  }

  return (
    <section className="panel task-control" aria-label="Task controls">
      <header className="panel-header"><h2>Task controls</h2></header>
      <div className="panel-body control-panel-body">
        {stage.kind === "success" ? (
          <PendingRequest command={stage.command} />
        ) : (
          <form className="control-form" onSubmit={submit}>
            <label className="form-field">
              <span>Cancellation reason</span>
              <textarea
                required
                value={reason}
                onChange={(event) => { setReason(event.target.value); }}
              />
            </label>
            <button type="submit" disabled={stage.kind === "loading" || reason.trim().length === 0}>
              Stage cancellation
            </button>
            {stage.kind === "loading" ? <p className="control-status" role="status">Staging cancellation</p> : null}
            {stage.kind === "error" ? <p className="control-error" role="alert">Unable to stage cancellation</p> : null}
          </form>
        )}
      </div>
    </section>
  );
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

function cancelRunId(
  state: string,
  sourceIds: readonly string[],
  events: readonly TaskDetailEvent[],
): string | undefined {
  if (TERMINAL_STATES.has(state) || state.trim().length === 0) return undefined;
  const candidates = events.flatMap((event) => {
    if (event.source !== "workflow" || event.kind !== "workflow") return [];
    return workflowRunId(event.event_id);
  });
  if (candidates.length !== 1) return undefined;
  const runId = candidates[0];
  if (runId === undefined || !isUsableId(runId)) return undefined;
  if (!sourceIds.includes(runId)) return undefined;
  return runId;
}

function workflowRunId(eventId: string): string[] {
  const prefix = "workflow:";
  const suffix = ":state";
  if (!eventId.startsWith(prefix) || !eventId.endsWith(suffix)) return [];
  const runId = eventId.slice(prefix.length, eventId.length - suffix.length);
  return runId.length === 0 || runId.includes(":") ? [] : [runId];
}

function isUsableId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value === value.normalize("NFC")
    && new TextEncoder().encode(value).length <= ID_LIMIT;
}

function isMutationError(error: unknown): error is DashboardApiError | TypeError | DOMException {
  return error instanceof DashboardApiError || error instanceof TypeError || error instanceof DOMException;
}
