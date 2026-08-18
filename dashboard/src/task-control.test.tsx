import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredControlCommand } from "../../src/control-plane.js";
import type { CancelRequest } from "../../src/dashboard/contracts.js";
import type { TaskDetailResponse } from "../../src/dashboard/read-model.js";
import { TaskControl } from "./task-control.js";

type TaskMutationClient = Readonly<{
  cancelTask: (taskId: string, request: CancelRequest) => Promise<StoredControlCommand>;
}>;
type GeneratedIdKind = "request_id" | "nonce";
type IdFactory = (kind: GeneratedIdKind) => string;

const AT = "2026-08-18T12:00:00.000Z";
const TASK_ID = "task-active-1";
const REQUEST_ID = "req-control-active-1";
const RUN_ID = "run-active-1";
const REASON = "Operator stopped an unsafe retry";
const IDS = {
  request_id: "req-cancel-deterministic",
  nonce: "nonce-cancel-deterministic",
} as const satisfies Record<GeneratedIdKind, string>;
const ACTIVE_DETAIL = {
  schema_version: 1,
  context: {
    task: {
      task_id: TASK_ID,
      title: "Active workflow",
      kind: "workflow",
      state: "running",
      updated_at: AT,
      pending_approval: false,
      // Production correlation: the active workflow task carries both the
      // control request id and the workflow run id as its sources.
      source_ids: [REQUEST_ID, RUN_ID],
    },
    events: [
      {
        event_id: `workflow:${RUN_ID}:state`,
        task_id: TASK_ID,
        source: "workflow",
        kind: "workflow",
        actor: "jarvis-loopgraph",
        title: "Active workflow",
        status: "running",
        payload: { run_id: RUN_ID, current_node: "run", attempts: 1, failure_code: null },
        evidence_refs: [],
        created_at: AT,
        sequence: 1,
      },
    ],
  },
} as const satisfies TaskDetailResponse;
const STAGED_CANCEL = {
  schema_version: 1,
  request_id: IDS.request_id,
  action: "workflow.cancel",
  action_level: 3,
  target: { environment: "local", run_id: RUN_ID, task_id: TASK_ID },
  args: { run_id: RUN_ID, reason: REASON, task_id: TASK_ID },
  reversible: true,
  requested_by: "jarvis-control-center",
  requested_at: AT,
  expires_at: "2026-08-18T12:15:00.000Z",
  nonce: IDS.nonce,
  command_digest: `sha256:${"c".repeat(64)}`,
  state: "pending",
} as const satisfies StoredControlCommand;

function detailWith(state: string, sourceIds: readonly string[] = [REQUEST_ID, RUN_ID]): TaskDetailResponse {
  return {
    ...ACTIVE_DETAIL,
    context: {
      ...ACTIVE_DETAIL.context,
      task: { ...ACTIVE_DETAIL.context.task, state, source_ids: sourceIds },
    },
  };
}

function createClient() {
  const cancelTask = vi.fn<TaskMutationClient["cancelTask"]>();
  const client = { cancelTask } satisfies TaskMutationClient;
  return { client, cancelTask };
}

function renderControl(detail: TaskDetailResponse, client: TaskMutationClient) {
  const idFactory = vi.fn<IdFactory>((kind) => IDS[kind]);
  render(<TaskControl detail={detail} client={client} idFactory={idFactory} />);
  return { user: userEvent.setup(), idFactory };
}

afterEach(cleanup);

describe("task cancellation controls", () => {
  it("stages cancellation for an active task with deterministic authority fields", async () => {
    // Given
    const current = createClient();
    current.cancelTask.mockResolvedValue(STAGED_CANCEL);
    const { user, idFactory } = renderControl(ACTIVE_DETAIL, current.client);
    const reason = screen.getByRole("textbox", { name: "Cancellation reason" });
    await user.type(reason, REASON);

    // When
    await user.click(screen.getByRole("button", { name: "Stage cancellation" }));

    // Then
    expect(current.cancelTask).toHaveBeenCalledOnce();
    expect(current.cancelTask).toHaveBeenCalledWith(TASK_ID, {
      schema_version: 1,
      request_id: IDS.request_id,
      nonce: IDS.nonce,
      run_id: RUN_ID,
      reason: REASON,
    });
    expect(idFactory.mock.calls.map(([kind]) => kind)).toEqual(["request_id", "nonce"]);
    const pending = await screen.findByRole("region", { name: "Pending request" });
    expect(within(pending).getByText(IDS.request_id)).toBeInTheDocument();
    expect(pending).toHaveTextContent("workflow.cancel");
    expect(pending).toHaveTextContent("Level 3");
    expect(pending).toHaveTextContent("pending");
  });

  it.each(["completed", "failed", "uncertain", "cancelled"])(
    "does not offer cancellation for a settled %s task",
    (state) => {
      // Given / When
      const current = createClient();
      renderControl(detailWith(state), current.client);

      // Then
      expect(screen.queryByRole("textbox", { name: "Cancellation reason" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stage cancellation" })).not.toBeInTheDocument();
      expect(current.cancelTask).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", []],
    ["blank", [""]],
    ["ambiguous", ["run-a", "run-b"]],
  ] as const)("does not offer cancellation for a %s run source", (_kind, sourceIds) => {
    // Given / When
    const current = createClient();
    renderControl(detailWith("running", sourceIds), current.client);

    // Then
    expect(screen.queryByRole("textbox", { name: "Cancellation reason" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stage cancellation" })).not.toBeInTheDocument();
    expect(current.cancelTask).not.toHaveBeenCalled();
  });
});
